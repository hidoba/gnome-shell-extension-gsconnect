// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import Config from '../../config.js';
import * as Components from '../components/index.js';
import {
    decodeImage,
    encodePng,
    getImageChecksum
} from '../components/clipboard.js';
import Plugin from '../plugin.js';


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
 * The maximum size of a file or image shared through the clipboard. This is the
 * same as the default of KDE Connect.
 */
const MAX_FILE_SIZE = 50 * 1024 * 1024;


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
 * Clipboard Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/clipboard
 */
const ClipboardPlugin = GObject.registerClass({
    GTypeName: 'GSConnectClipboardPlugin',
}, class ClipboardPlugin extends Plugin {

    _init(device) {
        super._init(device, 'clipboard');

        this._clipboard = Components.acquire('clipboard');

        // Watch local clipboard for changes
        this._contentChangedId = this._clipboard.connect(
            'content-changed',
            this._onLocalClipboardChanged.bind(this)
        );

        // Buffer content to allow selective sync
        this._localBuffer = this._clipboard.text;
        this._localTimestamp = 0;
        this._remoteBuffer = null;

        // The last content received from or sent to the device
        this._remoteContent = null;

        // Serials, to ignore operations superseded by a clipboard change
        this._localSerial = 0;
        this._remoteSerial = 0;
    }

    connected() {
        super.connected();

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

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.clipboard':
                if (packet.body.hasOwnProperty('content'))
                    this._handleContent(packet);
                break;

            case 'kdeconnect.clipboard.connect':
                if (packet.body.hasOwnProperty('content'))
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
     * Remove previously received files, which are no longer in the clipboard.
     *
     * @param {Gio.File} dir - The receive directory
     */
    async _cleanReceiveDirectory(dir) {
        try {
            const iter = await dir.enumerate_children_async(
                Gio.FILE_ATTRIBUTE_STANDARD_NAME,
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                GLib.PRIORITY_DEFAULT,
                this.cancellable);

            let infos;
            while ((infos = await iter.next_files_async(10,
                GLib.PRIORITY_DEFAULT, this.cancellable)).length > 0) {
                for (const info of infos) {
                    try {
                        await iter.get_child(info).delete_async(
                            GLib.PRIORITY_DEFAULT, this.cancellable);
                    } catch (e) {
                        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                            throw e;
                    }
                }
            }

            iter.close(null);
        } catch (e) {
            debug(e, this.device.name);
        }
    }

    async _handleFile(packet) {
        if (!packet.hasPayload() || typeof packet.body.filename !== 'string') {
            debug('Ignoring clipboard file without payload or filename',
                this.device.name);
            return;
        }

        // Only download files that will be applied to the clipboard
        if (!this.settings.get_boolean('receive-content') ||
            packet.payloadSize > MAX_FILE_SIZE) {
            this.device.rejectTransfer(packet);
            return;
        }

        const serial = ++this._remoteSerial;
        let file = null;

        try {
            // Remote-supplied filename is untrusted; collapse to a basename so
            // it can't escape the receive directory
            let basename = GLib.path_get_basename(packet.body.filename);
            if (!basename || basename === '.' || basename === '..' ||
                basename.includes('/'))
                basename = 'unnamed-file';

            const dir = this._getReceiveDirectory();
            await this._cleanReceiveDirectory(dir);
            file = dir.get_child(basename);

            const transfer = this.device.createTransfer();
            transfer.addFile(packet, file);
            await transfer.start(this.cancellable);

            const content = await this._loadFile(file);

            // Ignore files superseded by newer clipboard content
            if (serial !== this._remoteSerial) {
                file.delete_async(GLib.PRIORITY_DEFAULT, null, null);
                return;
            }

            this._onRemoteClipboardChanged(content);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                debug(e, this.device.name);

            file?.delete_async(GLib.PRIORITY_DEFAULT, null, null);
        }
    }

    /**
     * Get the clipboard content for a received file. Images are placed in the
     * clipboard as image data, while other files are placed as a file.
     *
     * @param {Gio.File} file - A received file
     * @returns {Promise<object>} A clipboard content
     */
    async _loadFile(file) {
        const info = await file.query_info_async(
            Gio.FILE_ATTRIBUTE_STANDARD_CONTENT_TYPE,
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            this.cancellable);
        const contentType = info.get_content_type();
        const mimetype = Gio.content_type_get_mime_type(contentType);

        if (mimetype?.startsWith('image/') && mimetype !== 'image/svg+xml') {
            try {
                const [contents] = await file.load_contents_async(
                    this.cancellable);
                const bytes = new GLib.Bytes(contents);
                const pixbuf = decodeImage(bytes);

                return {
                    type: 'image',
                    bytes: mimetype === 'image/png' ? bytes : encodePng(pixbuf),
                    checksum: getImageChecksum(pixbuf),
                    uri: file.get_uri(),
                };
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    throw e;

                debug(`Failed to load image: ${e.message}`, this.device.name);
            }
        }

        return {type: 'file', uri: file.get_uri()};
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

        if (this.settings.get_boolean('send-content'))
            this.clipboardPush();
    }

    /*
     * Store the remote clipboard content and apply it if enabled
     */
    _onRemoteClipboardChanged(content) {
        if (typeof content === 'string') {
            content = {type: 'text', text: content};
            this._remoteBuffer = content.text;
        } else {
            this._remoteBuffer = null;
        }

        // Supersede any file still being received
        if (content.type === 'text')
            this._remoteSerial++;

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
     * Copy to the remote clipboard; called by _onLocalClipboardChanged()
     */
    async clipboardPush() {
        // Don't sync if the clipboard is empty or unknown
        if (this._localTimestamp === 0)
            return;

        try {
            const serial = this._localSerial;
            const content = await this._getLocalContent();

            // Ignore content superseded by a newer clipboard change
            if (content === null || serial !== this._localSerial ||
                this.cancellable.is_cancelled())
                return;

            if (isSameContent(content, this._remoteContent))
                return;

            switch (content.type) {
                case 'text':
                    this._remoteContent = content;
                    this._remoteBuffer = content.text;
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
                    await this._sendFile(content);
                    break;
            }
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                debug(e, this.device.name);
        }
    }

    async _startTransfer(transfer, content) {
        try {
            await transfer.start(this.cancellable);
        } catch (e) {
            // Allow the content to be sent again
            if (this._remoteContent === content)
                this._remoteContent = null;

            throw e;
        }
    }

    async _sendImage(content) {
        if (!this.device.connected)
            return;

        const size = content.bytes.get_size();

        if (size > MAX_FILE_SIZE) {
            debug('Clipboard image exceeds the maximum size', this.device.name);
            return;
        }

        this._remoteContent = content;
        this._remoteBuffer = null;

        const transfer = this.device.createTransfer();
        transfer.addStream({
            type: 'kdeconnect.clipboard.file',
            body: {
                filename: `${Date.now()}.png`,
            },
        }, Gio.MemoryInputStream.new_from_bytes(content.bytes), size);

        await this._startTransfer(transfer, content);
    }

    async _sendFile(content) {
        if (!this.device.connected)
            return;

        const file = Gio.File.new_for_uri(content.uri);
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

        this._remoteContent = content;
        this._remoteBuffer = null;

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

        switch (content.type) {
            case 'text':
                if (this._localBuffer !== content.text) {
                    this._localBuffer = content.text;
                    this._localTimestamp = Date.now();

                    this._clipboard.text = content.text;
                }
                break;

            case 'image':
                this._localBuffer = null;
                this._localTimestamp = Date.now();
                this._clipboard.setImage(content.bytes);
                break;

            case 'file':
                this._localBuffer = null;
                this._localTimestamp = Date.now();
                this._clipboard.setFile(content.uri);
                break;
        }
    }

    destroy() {
        if (this._clipboard && this._contentChangedId) {
            this._clipboard.disconnect(this._contentChangedId);
            this._clipboard = Components.release('clipboard');
        }

        super.destroy();
    }
});

export default ClipboardPlugin;
