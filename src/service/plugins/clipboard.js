// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import Config from '../../config.js';
import * as Components from '../components/index.js';
import Plugin from '../plugin.js';
import {
    MAX_FILE_SIZE,
    MAX_IMAGE_PIXELS,
    decodeImage,
    encodePng,
    getImageChecksum,
    getImageFormat,
    getImageInfo
} from '../utils/image.js';


export const Metadata = {
    label: _('Clipboard'),
    description: _('Share the clipboard content'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Clipboard',
    incomingCapabilities: [
        'kdeconnect.clipboard',
        'kdeconnect.clipboard.connect',
        'kdeconnect.clipboard.file',
    ],
    outgoingCapabilities: [
        'kdeconnect.clipboard',
        'kdeconnect.clipboard.connect',
        'kdeconnect.clipboard.file',
    ],
    // Images and files are only shared when enabled
    capabilitySettings: {
        'kdeconnect.clipboard.file': 'clipboard-files',
    },
    actions: {
        clipboardPush: {
            label: _('Clipboard Push'),
            icon_name: 'edit-paste-symbolic',

            parameter_type: null,
            incoming: [],
            outgoing: ['kdeconnect.clipboard'],
        },
        clipboardPull: {
            label: _('Clipboard Pull'),
            icon_name: 'edit-copy-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.clipboard'],
            outgoing: [],
        },
    },
};


/**
 * Check if two clipboard contents are the same.
 *
 * @param {object|null} a - A clipboard content
 * @param {object|null} b - A clipboard content
 * @returns {boolean} %true if the contents are the same
 */
function isSameContent(a, b) {
    if (a === null || b === null || a.type !== b.type)
        return false;

    switch (a.type) {
        case 'text':
            return a.text === b.text;

        case 'file':
            return a.uri === b.uri;

        case 'image':
            return a.checksum === b.checksum;
    }

    return false;
}


/**
 * The maximum number of contents applied from a device, which are expected to
 * be reported as local clipboard changes.
 */
const MAX_PENDING_ECHOES = 4;


/**
 * The maximum length in bytes of the name of a received file, which leaves
 * room for a PNG copy within the usual limit of 255 bytes.
 */
const MAX_BASENAME = 200;


/**
 * Get a safe local name for a file received from a device.
 *
 * @param {string} filename - The untrusted name chosen by the device
 * @returns {string} A file name
 */
function getSafeBasename(filename) {
    // Collapse to a basename, so it can't escape the receive directory
    const basename = GLib.path_get_basename(filename);

    if (!basename || basename === '.' || basename === '..' ||
        basename.includes('/'))
        return 'unnamed-file';

    const encoder = new TextEncoder();

    if (encoder.encode(basename).length <= MAX_BASENAME)
        return basename;

    // Shorten the name, keeping a reasonable extension
    const dot = basename.lastIndexOf('.');
    let extension = dot > 0 ? basename.slice(dot) : '';

    if (encoder.encode(extension).length > 16)
        extension = '';

    const chars = Array.from(basename.slice(0, basename.length -
        extension.length)).slice(0, MAX_BASENAME);

    while (chars.length > 0 &&
        encoder.encode(chars.join('') + extension).length > MAX_BASENAME)
        chars.pop();

    return `${chars.join('') || 'unnamed-file'}${extension}`;
}


/**
 * Check if a file was received through the clipboard from any device.
 *
 * @param {Gio.File} file - A file
 * @returns {boolean} %true if the file was received from a device
 */
function isReceivedFile(file) {
    const cachedir = Gio.File.new_for_path(Config.CACHEDIR);
    const path = cachedir.get_relative_path(file);

    // See ClipboardPlugin._getReceiveDirectory()
    return path !== null && path.split('/')[1] === 'clipboard';
}


/**
 * Clipboard Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/clipboard
 */
const ClipboardPlugin = GObject.registerClass({
    GTypeName: 'GSConnectClipboardPlugin',
}, class ClipboardPlugin extends Plugin {

    _init(device) {
        super._init(device, 'clipboard');

        this._clipboard = Components.acquire('clipboard');

        // Sharing images and files is a global setting
        this._serviceSettings = new Gio.Settings({
            settings_schema: Config.GSCHEMA.lookup(Config.APP_ID, true),
        });

        // Watch local clipboard for changes
        this._contentChangedId = this._clipboard.connect(
            'content-changed',
            this._onLocalClipboardChanged.bind(this)
        );

        // Buffer content to allow selective sync
        this._localBuffer = this._clipboard.text;
        this._localTimestamp = 0;

        // The last content received from or sent to the device
        this._remoteContent = null;

        // The last content applied to the local clipboard from the device
        this._pulledContent = null;

        // The pending transfers of a file or image to and from the device
        this._outgoingTransfer = null;
        this._incomingTransfer = null;

        // Cancels receiving, loading and converting a file from the device
        this._incomingCancellable = null;

        // Directories of files being received, which must not be cleaned up
        this._receivingDirs = new Set();

        // The directory of the received file in the clipboard, if any
        this._currentDir = null;

        // Contents applied from the device, which are yet to be reported as
        // local clipboard changes, oldest first
        this._pendingEchoes = [];

        // Serials, to ignore operations superseded by a clipboard change
        this._localSerial = 0;
        this._remoteSerial = 0;
    }

    connected() {
        super.connected();

        // The remote clipboard may have changed while disconnected
        this._remoteContent = null;
        this._pulledContent = null;

        // TODO: if we're not auto-syncing local->remote, but we are doing the
        //       reverse, it's possible older remote content will end up
        //       overwriting newer local content.
        if (!this.settings.get_boolean('send-content'))
            return;

        // Files and images are not sent on connection
        if (typeof this._localBuffer !== 'string')
            return;

        if (this._localBuffer === '' && this._localTimestamp === 0)
            return;

        this.device.sendPacket({
            type: 'kdeconnect.clipboard.connect',
            body: {
                content: this._localBuffer,
                timestamp: this._localTimestamp,
            },
        });
    }

    disconnected() {
        super.disconnected();

        // Pending transfers can't complete without a connection
        this._cancelIncomingTransfer();
        this._cancelOutgoingTransfer();
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.clipboard':
                if (typeof packet.body.content === 'string')
                    this._handleContent(packet);
                break;

            case 'kdeconnect.clipboard.connect':
                if (typeof packet.body.content === 'string')
                    this._handleConnectContent(packet);
                break;

            case 'kdeconnect.clipboard.file':
                this._handleFile(packet);
                break;
        }
    }

    _handleContent(packet) {
        this._onRemoteClipboardChanged(packet.body.content);
    }

    _handleConnectContent(packet) {
        if (packet.body.hasOwnProperty('timestamp') &&
            packet.body.timestamp > this._localTimestamp)
            this._onRemoteClipboardChanged(packet.body.content);
    }

    /**
     * Get the directory for files received through the clipboard.
     *
     * @returns {Gio.File} The directory
     */
    _getReceiveDirectory() {
        const path = GLib.build_filenamev([
            Config.CACHEDIR,
            this.device.id,
            'clipboard',
        ]);
        GLib.mkdir_with_parents(path, 448);

        return Gio.File.new_for_path(path);
    }

    /**
     * Recursively delete the contents of a directory.
     *
     * @param {Gio.File} dir - A directory
     * @param {function(Gio.File): boolean} [keep] - Selects children to keep
     * @param {Gio.Cancellable} [cancellable] - A cancellable
     */
    async _deleteChildren(dir, keep = null, cancellable = null) {
        const iter = await dir.enumerate_children_async(
            [
                Gio.FILE_ATTRIBUTE_STANDARD_NAME,
                Gio.FILE_ATTRIBUTE_STANDARD_TYPE,
            ].join(','),
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT,
            cancellable);

        try {
            let infos;
            while ((infos = await iter.next_files_async(10,
                GLib.PRIORITY_DEFAULT, cancellable)).length > 0) {
                for (const info of infos) {
                    const child = iter.get_child(info);

                    if (keep?.(child))
                        continue;

                    try {
                        if (info.get_file_type() === Gio.FileType.DIRECTORY)
                            await this._deleteChildren(child, null, cancellable);

                        await child.delete_async(GLib.PRIORITY_DEFAULT,
                            cancellable);
                    } catch (e) {
                        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                            throw e;
                    }
                }
            }
        } finally {
            iter.close(null);
        }
    }

    /**
     * Remove received files, which are no longer in the clipboard.
     *
     * @param {Gio.File} dir - The receive directory
     */
    async _cleanReceiveDirectory(dir) {
        // The kept directories are checked as each is reached, since they may
        // change while cleaning up
        const keep = child => this._currentDir?.equal(child) ||
            this._receivingDirs.has(child.get_path());

        try {
            await this._deleteChildren(dir, keep, this.cancellable);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                debug(e, this.device.name);
        }
    }

    /**
     * Remove a directory and its contents.
     *
     * This is not cancellable, so a partially received file is removed even
     * if the plugin is destroyed.
     *
     * @param {Gio.File} dir - A directory
     */
    async _removeDirectory(dir) {
        try {
            await this._deleteChildren(dir);
            await dir.delete_async(GLib.PRIORITY_DEFAULT, null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                debug(e, this.device.name);
        }
    }

    async _handleFile(packet) {
        if (!packet.hasPayload() || typeof packet.body.filename !== 'string') {
            debug('Ignoring clipboard file without payload or filename',
                this.device.name);
            return;
        }

        // The remote clipboard changed, regardless of the file being accepted
        this._cancelIncomingTransfer();
        this._cancelOutgoingTransfer();
        const serial = ++this._remoteSerial;
        this._remoteContent = null;

        // Only download files that will be applied to the clipboard
        if (!this._serviceSettings.get_boolean('clipboard-files') ||
            !this.settings.get_boolean('receive-content') ||
            !(packet.payloadSize >= 0 && packet.payloadSize <= MAX_FILE_SIZE)) {
            this.device.rejectTransfer(packet);
            return;
        }

        let dir = null;
        let started = false;

        // Cancelled when superseded, or when the plugin is destroyed
        const cancellable = new Gio.Cancellable();
        const cancelledId = this.cancellable.connect(() => cancellable.cancel());
        this._incomingCancellable = cancellable;

        try {
            const basename = getSafeBasename(packet.body.filename);

            // Each file gets its own directory, so a superseded transfer can
            // be removed without affecting a newer file of the same name
            const receiveDir = this._getReceiveDirectory();
            dir = receiveDir.get_child(`${Date.now()}-${serial}`);
            dir.make_directory(null);
            this._receivingDirs.add(dir.get_path());

            const file = dir.get_child(basename);
            const transfer = this.device.createTransfer();
            transfer.addFile(packet, file);

            this._incomingTransfer = transfer;
            started = true;

            try {
                await transfer.start(cancellable);
            } finally {
                if (this._incomingTransfer === transfer)
                    this._incomingTransfer = null;
            }

            const content = await this._loadFile(file, cancellable);

            // Ignore files superseded by newer clipboard content
            if (serial !== this._remoteSerial || cancellable.is_cancelled()) {
                await this._removeDirectory(dir);
                return;
            }

            this._currentDir = dir;
            this._receivingDirs.delete(dir.get_path());
            this._onRemoteClipboardChanged(content);

            // Remove previously received files, which this one replaces
            await this._cleanReceiveDirectory(receiveDir);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                debug(e, this.device.name);

            // Don't leave the device waiting to send the file
            if (!started)
                this.device.rejectTransfer(packet);

            if (dir !== null && dir !== this._currentDir)
                await this._removeDirectory(dir);
        } finally {
            if (dir !== null)
                this._receivingDirs.delete(dir.get_path());

            this.cancellable.disconnect(cancelledId);

            if (this._incomingCancellable === cancellable)
                this._incomingCancellable = null;
        }
    }

    /**
     * Get the clipboard content for a received file. Images are placed in the
     * clipboard as image data, while other files are placed as a file.
     *
     * @param {Gio.File} file - A received file
     * @param {Gio.Cancellable} cancellable - A cancellable
     * @returns {Promise<object>} A clipboard content
     */
    async _loadFile(file, cancellable) {
        // The name of the file is chosen by the device, so images are
        // recognized from their contents, before passing them to a loader
        const format = await getImageFormat(file, cancellable);

        if (format !== null) {
            try {
                return await this._loadImage(file, format, cancellable);
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    throw e;

                debug(`Failed to load image: ${e.message}`, this.device.name);
            }
        }

        return {type: 'file', uri: file.get_uri()};
    }

    /**
     * Get the clipboard content for a received image.
     *
     * Images that aren't PNG are converted, and the PNG data is written next
     * to the received file, so it doesn't have to be kept in memory.
     *
     * @param {Gio.File} file - A received image
     * @param {string} format - The format of the image
     * @param {Gio.Cancellable} cancellable - A cancellable
     * @returns {Promise<object>} A clipboard content
     */
    async _loadImage(file, format, cancellable) {
        // Check the dimensions before decoding the image
        const [info, width, height] = await getImageInfo(file, cancellable);

        if (info?.get_name() !== format)
            throw new Error(`Unexpected image format: ${info?.get_name()}`);

        if (width * height > MAX_IMAGE_PIXELS)
            throw new Error(`Image is too large: ${width}x${height}`);

        const [contents] = await file.load_contents_async(cancellable);
        const pixbuf = await decodeImage(new GLib.Bytes(contents), cancellable);
        cancellable.set_error_if_cancelled();

        let pngFile = file;

        if (format !== 'png') {
            const bytes = await encodePng(pixbuf, cancellable);

            if (bytes.get_size() > MAX_FILE_SIZE)
                throw new Error('Image is too large once converted to PNG');

            pngFile = file.get_parent().get_child(`${file.get_basename()}.png`);
            await pngFile.replace_contents_bytes_async(bytes, null, false,
                Gio.FileCreateFlags.PRIVATE, cancellable);
        }

        return {
            type: 'image',
            checksum: await getImageChecksum(pixbuf, cancellable),
            uri: pngFile.get_uri(),
        };
    }

    /*
     * Store the local clipboard content and forward it if enabled
     */
    _onLocalClipboardChanged(clipboard) {
        const content = clipboard.content;

        // Like KDE Connect, ignore a cleared clipboard
        if (content === null || (content.type === 'text' && content.text === ''))
            return;

        this._localSerial++;
        this._localBuffer = content.type === 'text' ? content.text : null;
        this._localTimestamp = Date.now();

        // Supersede any content still being received or applied from the
        // device, unless this is that content being applied
        if (!this._isAppliedContent(content)) {
            this._cancelIncomingTransfer();
            this._remoteSerial++;
            this._pendingEchoes = [];

            // Content applied from the device may be reported again, for
            // example by a clipboard manager, and is still in the clipboard
            if (!isSameContent(content, this._pulledContent)) {
                this._pulledContent = null;
                this._currentDir = null;
            }
        }

        if (this.settings.get_boolean('send-content'))
            this.clipboardPush();
    }

    /**
     * Check if a local clipboard change is the content applied from the
     * device.
     *
     * @param {object} content - The local clipboard content
     * @returns {boolean} %true if the content was applied from the device
     */
    _isAppliedContent(content) {
        // Images are not read just to compare them, so the first image after
        // applying one is assumed to be it
        const index = this._pendingEchoes.findIndex(pending => {
            return content.type === 'image'
                ? pending.type === 'image'
                : isSameContent(content, pending);
        });

        // Applied content is only reported once, so copying the same content
        // again is a new change. Content applied before it may not be
        // reported at all, if superseded before it was read.
        if (index !== -1)
            this._pendingEchoes.splice(0, index + 1);

        return index !== -1;
    }

    /**
     * Expect content applied from the device to be reported as a local
     * clipboard change.
     *
     * @param {object} content - The content being applied
     */
    _expectEcho(content) {
        this._pendingEchoes.push(content);

        if (this._pendingEchoes.length > MAX_PENDING_ECHOES)
            this._pendingEchoes.shift();
    }

    /**
     * Stop expecting content to be reported, if it is still expected.
     *
     * @param {object} content - The content no longer being applied
     * @param {object|null} [replacement] - What is expected instead
     */
    _unexpectEcho(content, replacement = null) {
        const index = this._pendingEchoes.indexOf(content);

        if (index === -1)
            return;

        if (replacement !== null)
            this._pendingEchoes[index] = replacement;
        else
            this._pendingEchoes.splice(index, 1);
    }

    /*
     * Store the remote clipboard content and apply it if enabled
     */
    _onRemoteClipboardChanged(content) {
        if (typeof content === 'string')
            content = {type: 'text', text: content};

        // Supersede any content still being sent to the device
        this._cancelOutgoingTransfer();

        // Supersede any file still being received
        if (content.type === 'text') {
            this._cancelIncomingTransfer();
            this._remoteSerial++;
        }

        this._remoteContent = content;

        if (this.settings.get_boolean('receive-content'))
            this.clipboardPull();
    }

    /**
     * Get the current local clipboard content, including the data of images.
     *
     * @returns {Promise<object|null>} A clipboard content
     */
    async _getLocalContent() {
        const content = this._clipboard.content;

        if (content?.type !== 'image')
            return content;

        const image = await this._clipboard.getImage();

        if (image === null)
            return null;

        return {type: 'image', bytes: image.bytes, checksum: image.checksum};
    }

    /**
     * Whether the device accepts files and images through the clipboard.
     *
     * @returns {boolean} %true if supported
     */
    _canSendFiles() {
        if (!this._serviceSettings.get_boolean('clipboard-files'))
            return false;

        if (!this.device.connected)
            return false;

        const incoming = this.device.settings.get_strv('incoming-capabilities');
        return incoming.includes('kdeconnect.clipboard.file');
    }

    /**
     * Check if the clipboard changed on either side, or the plugin was
     * destroyed, since an operation began.
     *
     * @param {number} localSerial - The local serial when it began
     * @param {number} remoteSerial - The remote serial when it began
     * @returns {boolean} %true if the operation was superseded
     */
    _isSuperseded(localSerial, remoteSerial) {
        return localSerial !== this._localSerial ||
            remoteSerial !== this._remoteSerial ||
            this.cancellable.is_cancelled();
    }

    /**
     * Cancel the pending transfer of a file or image from the device, which
     * has been superseded by newer clipboard content.
     */
    _cancelIncomingTransfer() {
        if (this._incomingTransfer !== null) {
            this._incomingTransfer.cancel();
            this._incomingTransfer = null;
        }

        if (this._incomingCancellable !== null) {
            this._incomingCancellable.cancel();
            this._incomingCancellable = null;
        }
    }

    /**
     * Cancel the pending transfer of a file or image, which has been
     * superseded by newer clipboard content.
     */
    _cancelOutgoingTransfer() {
        if (this._outgoingTransfer !== null) {
            this._outgoingTransfer.cancel();
            this._outgoingTransfer = null;
        }
    }

    /**
     * Copy to the remote clipboard; called by _onLocalClipboardChanged()
     */
    async clipboardPush() {
        // Don't sync if the clipboard is empty or unknown
        if (this._localTimestamp === 0)
            return;

        // Avoid reading images and files that can't be sent anyway
        const type = this._clipboard.content?.type;

        if (type !== undefined && type !== 'text' && !this._canSendFiles())
            return;

        try {
            const localSerial = this._localSerial;
            const remoteSerial = this._remoteSerial;
            const content = await this._getLocalContent();

            // Ignore content superseded by a newer clipboard change
            if (content === null ||
                this._isSuperseded(localSerial, remoteSerial))
                return;

            if (isSameContent(content, this._remoteContent))
                return;

            // Don't send back content applied from the device
            if (isSameContent(content, this._pulledContent))
                return;

            this._pulledContent = null;

            switch (content.type) {
                case 'text':
                    this._cancelOutgoingTransfer();
                    this._remoteContent = content;
                    this.device.sendPacket({
                        type: 'kdeconnect.clipboard',
                        body: {
                            content: content.text,
                        },
                    });
                    break;

                case 'image':
                    await this._sendImage(content);
                    break;

                case 'file':
                    await this._sendFile(content, localSerial, remoteSerial);
                    break;
            }
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                debug(e, this.device.name);
        }
    }

    async _startTransfer(transfer, content) {
        this._cancelOutgoingTransfer();
        this._outgoingTransfer = transfer;

        try {
            await transfer.start(this.cancellable);
        } catch (e) {
            // Allow the content to be sent again
            if (this._remoteContent === content)
                this._remoteContent = null;

            throw e;
        } finally {
            if (this._outgoingTransfer === transfer)
                this._outgoingTransfer = null;
        }
    }

    async _sendImage(content) {
        if (!this._canSendFiles())
            return;

        const size = content.bytes.get_size();

        if (size > MAX_FILE_SIZE) {
            debug('Clipboard image exceeds the maximum size', this.device.name);
            return;
        }

        // Only the checksum is kept, to avoid keeping the image in memory
        const remoteContent = {type: 'image', checksum: content.checksum};
        this._remoteContent = remoteContent;

        const transfer = this.device.createTransfer();
        transfer.addStream({
            type: 'kdeconnect.clipboard.file',
            body: {
                filename: `${Date.now()}.png`,
            },
        }, Gio.MemoryInputStream.new_from_bytes(content.bytes), size);

        await this._startTransfer(transfer, remoteContent);
    }

    async _sendFile(content, localSerial, remoteSerial) {
        if (!this._canSendFiles())
            return;

        const file = Gio.File.new_for_uri(content.uri);

        // Received files are not forwarded to other devices, which would see
        // them as a new file each time and send them on again
        if (isReceivedFile(file)) {
            debug(`Not forwarding a received file: ${content.uri}`,
                this.device.name);
            return;
        }
        const info = await file.query_info_async(
            [
                Gio.FILE_ATTRIBUTE_STANDARD_TYPE,
                Gio.FILE_ATTRIBUTE_STANDARD_SIZE,
            ].join(','),
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            this.cancellable);

        if (info.get_file_type() !== Gio.FileType.REGULAR) {
            debug(`Not a regular file: ${content.uri}`, this.device.name);
            return;
        }

        if (info.get_size() > MAX_FILE_SIZE) {
            debug(`Clipboard file exceeds the maximum size: ${content.uri}`,
                this.device.name);
            return;
        }

        // Ignore content superseded while querying the file
        if (this._isSuperseded(localSerial, remoteSerial))
            return;

        this._remoteContent = content;

        const transfer = this.device.createTransfer();
        transfer.addFile({
            type: 'kdeconnect.clipboard.file',
            body: {
                filename: file.get_basename(),
            },
        }, file);

        await this._startTransfer(transfer, content);
    }

    /**
     * Copy from the remote clipboard; called by _onRemoteClipboardChanged()
     */
    clipboardPull() {
        const content = this._remoteContent;

        if (content === null)
            return;

        // The content is recorded before it is applied, so the resulting
        // local clipboard change is recognized as it
        switch (content.type) {
            case 'text':
                this._pulledContent = content;

                if (this._localBuffer !== content.text) {
                    this._localBuffer = content.text;
                    this._localTimestamp = Date.now();

                    this._expectEcho(content);
                    this._clipboard.text = content.text;
                }
                break;

            case 'image':
                // Images sent to the device have no file to apply
                if (content.uri === undefined)
                    break;

                this._localBuffer = null;
                this._localTimestamp = Date.now();
                this._pulledContent = content;
                this._applyImage(content);
                break;

            case 'file': {
                this._localBuffer = null;
                this._localTimestamp = Date.now();
                this._pulledContent = content;
                this._expectEcho(content);

                // The clipboard may hold the file in another form
                const applied = this._clipboard.setFile(content.uri);
                this._pulledContent = applied;
                this._unexpectEcho(content, applied);
                break;
            }
        }
    }

    /**
     * Place a received image in the clipboard as PNG data.
     *
     * @param {object} content - A received image
     */
    async _applyImage(content) {
        const serial = this._remoteSerial;

        try {
            // Don't replace a local image with the same image, which may have
            // come back through another device
            if (this._clipboard.content?.type === 'image') {
                const image = await this._clipboard.getImage();

                if (image?.checksum === content.checksum)
                    return;
            }

            const file = Gio.File.new_for_uri(content.uri);
            const [contents] = await file.load_contents_async(this.cancellable);

            // Ignore the image if the clipboard changed on either side in the
            // meantime
            if (this._pulledContent !== content || serial !== this._remoteSerial)
                return;

            this._expectEcho(content);
            const applied = await this._clipboard.setImage(
                new GLib.Bytes(contents), content.checksum);

            if (!applied)
                this._unexpectEcho(content);
        } catch (e) {
            this._unexpectEcho(content);

            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                debug(e, this.device.name);
        }
    }

    clearCache() {
        // Files still in the clipboard or being received are kept
        return this._cleanReceiveDirectory(this._getReceiveDirectory());
    }

    destroy() {
        this._cancelIncomingTransfer();
        this._cancelOutgoingTransfer();

        if (this._clipboard && this._contentChangedId) {
            this._clipboard.disconnect(this._contentChangedId);
            this._clipboard = Components.release('clipboard');
        }

        super.destroy();
    }
});

export default ClipboardPlugin;
