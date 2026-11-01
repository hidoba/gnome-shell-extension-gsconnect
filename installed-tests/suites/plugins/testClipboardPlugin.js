// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Utils from '../fixtures/utils.js';

import Config from '../config.js';
const Core = await import(`file://${Config.PACKAGE_DATADIR}/service/core.js`);
const {decodeImage, getImageChecksum} = await import(
    `file://${Config.PACKAGE_DATADIR}/service/utils/image.js`);


const CAPABILITIES = [
    'kdeconnect.clipboard',
    'kdeconnect.clipboard.connect',
    'kdeconnect.clipboard.file',
];


/**
 * Create a mock transfer, which copies a file to the download target.
 *
 * @param {Gio.File} source - The file to "download"
 * @returns {object} A mock transfer
 */
function mockTransfer(source) {
    return {
        _items: [],
        addFile(packet, file) {
            this._items.push(file);
        },
        start() {
            for (const file of this._items)
                source.copy(file, Gio.FileCopyFlags.OVERWRITE, null, null);

            return Promise.resolve();
        },
    };
}


/**
 * Create a mock transfer, which doesn't complete until cancelled.
 *
 * @returns {object} A mock transfer
 */
function pendingTransfer() {
    return {
        addFile() {},
        start(cancellable) {
            return new Promise((resolve, reject) => {
                this.cancel = jasmine.createSpy('cancel').and.callFake(() => {
                    reject(new Gio.IOErrorEnum({
                        code: Gio.IOErrorEnum.CANCELLED,
                        message: 'Cancelled',
                    }));
                });

                // Like a real transfer, follow the cancellable passed in
                cancellable?.connect(() => this.cancel());
            });
        },
    };
}


/**
 * List the names of the children of a directory.
 *
 * @param {Gio.File} dir - A directory
 * @returns {string[]} The names of the children
 */
function listChildren(dir) {
    const names = [];
    const iter = dir.enumerate_children('standard::name',
        Gio.FileQueryInfoFlags.NONE, null);

    let info;
    while ((info = iter.next_file(null)) !== null)
        names.push(info.get_name());

    iter.close(null);
    return names;
}


/**
 * Write a file in a new temporary directory.
 *
 * @param {string} name - The file name
 * @param {function(string)} write - Writes the file at a path
 * @returns {Gio.File} The file
 */
function tempFile(name, write) {
    const path = GLib.build_filenamev([GLib.dir_make_tmp(null), name]);
    write(path);

    return Gio.File.new_for_path(path);
}


/**
 * Create a clipboard file packet with a payload.
 *
 * @param {string} filename - The filename
 * @param {number} [size] - The payload size
 * @returns {object} A packet
 */
function filePacket(filename, size = 1024) {
    return new Core.Packet({
        type: 'kdeconnect.clipboard.file',
        body: {filename: filename},
        payloadSize: size,
        payloadTransferInfo: {port: 1739},
    });
}


/**
 * Create pseudo-random data.
 *
 * @param {number} length - The length
 * @returns {Uint8Array} The data
 */
function noise(length) {
    const data = new Uint8Array(length);
    let state = 1;

    for (let i = 0; i < length; i++) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        data[i] = state >> 16;
    }

    return data;
}


/**
 * Compute the expected checksum of pixel data without padding, which is the
 * SHA-256 of the digests of each 4 MiB of it.
 *
 * @param {string} dimensions - The dimensions, as `WxHxC`
 * @param {Uint8Array} data - Pixel data without padding
 * @returns {string} The checksum
 */
function referenceChecksum(dimensions, data) {
    const chunkSize = 4 * 1024 * 1024;
    const checksum = new GLib.Checksum(GLib.ChecksumType.SHA256);

    for (let offset = 0; offset < data.length; offset += chunkSize) {
        checksum.update(new TextEncoder().encode(GLib.compute_checksum_for_data(
            GLib.ChecksumType.SHA256,
            data.subarray(offset, offset + chunkSize))));
    }

    return `${dimensions}:${checksum.get_string()}`;
}


describe('The clipboard plugin', function () {
    let testRig;
    let localPlugin, remotePlugin;

    beforeAll(async function () {
        await Utils.mockComponents();

        testRig = new Utils.TestRig();
        await testRig.prepare({
            localDevice: {
                incomingCapabilities: CAPABILITIES,
                outgoingCapabilities: CAPABILITIES,
            },
            remoteDevice: {
                incomingCapabilities: CAPABILITIES,
                outgoingCapabilities: CAPABILITIES,
            },
        });
        testRig.setPaired(true);
    });

    afterAll(function () {
        testRig.destroy();
    });

    beforeEach(function () {
        if (remotePlugin && localPlugin) {
            spyOn(remotePlugin, 'handlePacket').and.callThrough();
            spyOn(localPlugin.device, 'sendPacket').and.callThrough();
        }
    });

    it('can be loaded', async function () {
        await testRig.loadPlugins();

        localPlugin = testRig.localDevice._plugins.get('clipboard');
        remotePlugin = testRig.remoteDevice._plugins.get('clipboard');

        expect(localPlugin).toBeDefined();
        expect(remotePlugin).toBeDefined();
    });

    it('enables its GActions when connected', function () {
        testRig.setConnected(true);

        expect(localPlugin.device.get_action_enabled('clipboardPush')).toBeTrue();
        expect(localPlugin.device.get_action_enabled('clipboardPull')).toBeTrue();

        expect(remotePlugin.device.get_action_enabled('clipboardPush')).toBeTrue();
        expect(remotePlugin.device.get_action_enabled('clipboardPull')).toBeTrue();
    });

    it('sends initial clipboard content when connected', async function () {
        // Prime the clipboard and simulate a new connection
        localPlugin._localBuffer = localPlugin._clipboard.text;
        localPlugin._localTimestamp = Date.now();

        localPlugin.settings.set_boolean('send-content', true);
        localPlugin.connected();

        await remotePlugin.awaitPacket('kdeconnect.clipboard.connect');
        expect(remotePlugin._remoteContent.text).toBe('initial');

        localPlugin.settings.set_boolean('send-content', false);
    });

    it('will not push content when not allowed', function () {
        localPlugin._clipboard.text = 'foo';
        expect(localPlugin.device.sendPacket).not.toHaveBeenCalled();
    });

    it('will push content when allowed', async function () {
        localPlugin.settings.set_boolean('send-content', true);
        localPlugin._clipboard.text = 'bar';

        await remotePlugin.awaitPacket('kdeconnect.clipboard');
        expect(remotePlugin._remoteContent.text).toBe('bar');
    });

    it('will not pull content when not allowed', async function () {
        localPlugin._clipboard.text = 'baz';

        await remotePlugin.awaitPacket('kdeconnect.clipboard');
        expect(remotePlugin._clipboard.text).not.toBe('baz');
    });

    it('will pull content when allowed', async function () {
        remotePlugin.settings.set_boolean('receive-content', true);
        localPlugin._clipboard.text = 'qux';

        await remotePlugin.awaitPacket('kdeconnect.clipboard');
        expect(remotePlugin._clipboard.text).toBe('qux');
    });

    it('does not push the same text twice', async function () {
        localPlugin._clipboard._setContent({type: 'text', text: 'qux'});

        await Promise.idle(GLib.PRIORITY_DEFAULT);
        expect(localPlugin.device.sendPacket).not.toHaveBeenCalled();
    });

    it('does not push a cleared clipboard', async function () {
        localPlugin._clipboard.text = '';

        await Promise.idle(GLib.PRIORITY_DEFAULT);
        expect(localPlugin.device.sendPacket).not.toHaveBeenCalled();
    });

    it('only advertises sharing images and files when enabled', function () {
        const service = new Core.ChannelService({id: 'test', name: 'test'});
        const settings = localPlugin._serviceSettings;
        const capability = 'kdeconnect.clipboard.file';

        settings.set_boolean('clipboard-files', false);
        service.buildIdentity();
        expect(service.identity.body.incomingCapabilities).not.toContain(capability);
        expect(service.identity.body.outgoingCapabilities).not.toContain(capability);
        expect(service.identity.body.incomingCapabilities).toContain('kdeconnect.clipboard');

        settings.set_boolean('clipboard-files', true);
        service.buildIdentity();
        expect(service.identity.body.incomingCapabilities).toContain(capability);
        expect(service.identity.body.outgoingCapabilities).toContain(capability);

        settings.set_boolean('clipboard-files', false);
    });

    it('does not read images or files when sharing them is disabled', async function () {
        spyOn(localPlugin._clipboard, 'getImage').and.callThrough();
        spyOn(localPlugin, 'clipboardPush').and.callThrough();

        const [, contents] = GLib.file_get_contents(
            Utils.getDataPath('album.png'));
        await localPlugin._clipboard.setImage(new GLib.Bytes(contents));
        await localPlugin.clipboardPush.calls.mostRecent().returnValue;

        localPlugin._clipboard.setFile(Utils.getDataUri('vcard-valid.vcf'));
        await localPlugin.clipboardPush.calls.mostRecent().returnValue;

        expect(localPlugin._clipboard.getImage).not.toHaveBeenCalled();
        expect(localPlugin.device.sendPacket).not.toHaveBeenCalled();
    });

    it('rejects files when sharing them is disabled', async function () {
        spyOn(remotePlugin.device, 'createTransfer');
        spyOn(remotePlugin.device, 'rejectTransfer');

        await remotePlugin._handleFile(filePacket('album.png'));

        expect(remotePlugin.device.rejectTransfer).toHaveBeenCalled();
        expect(remotePlugin.device.createTransfer).not.toHaveBeenCalled();
    });

    it('pushes images as PNG files', async function () {
        // The setting is shared by both plugins
        localPlugin._serviceSettings.set_boolean('clipboard-files', true);
        localPlugin._clipboard.text = 'reset';
        await remotePlugin.awaitPacket('kdeconnect.clipboard', {
            content: 'reset',
        });

        spyOn(localPlugin.device, 'createTransfer').and.callThrough();

        const [, contents] = GLib.file_get_contents(
            Utils.getDataPath('album.png'));
        await localPlugin._clipboard.setImage(new GLib.Bytes(contents));

        await remotePlugin.awaitPacket('kdeconnect.clipboard.file');
        const [packet] = remotePlugin.handlePacket.calls.mostRecent().args;

        expect(packet.body.filename).toMatch(/^[0-9]+\.png$/);
        expect(packet.payloadSize).toBeGreaterThan(0);
    });

    it('does not push the same image twice', async function () {
        const [, contents] = GLib.file_get_contents(
            Utils.getDataPath('album.png'));

        spyOn(localPlugin, 'clipboardPush').and.callThrough();

        // The re-encoded image has the same pixels
        await localPlugin._clipboard.setImage(new GLib.Bytes(contents));

        await localPlugin.clipboardPush.calls.mostRecent().returnValue;
        expect(localPlugin.device.sendPacket).not.toHaveBeenCalled();
    });

    it('pushes copied files', async function () {
        localPlugin._clipboard.setFile(Utils.getDataUri('vcard-valid.vcf'));

        await remotePlugin.awaitPacket('kdeconnect.clipboard.file', {
            filename: 'vcard-valid.vcf',
        });
    });

    it('pushes text after a file, even if unchanged', async function () {
        localPlugin._clipboard.text = 'qux';

        await remotePlugin.awaitPacket('kdeconnect.clipboard', {
            content: 'qux',
        });
        expect(localPlugin._remoteContent).toEqual({type: 'text', text: 'qux'});
    });

    it('does not push directories', async function () {
        spyOn(localPlugin, 'clipboardPush').and.callThrough();

        localPlugin._clipboard.setFile(
            Gio.File.new_for_path(Utils.getDataPath('album.png'))
                .get_parent().get_uri());

        // Wait for the asynchronous file query
        await localPlugin.clipboardPush.calls.mostRecent().returnValue;
        expect(localPlugin.device.sendPacket).not.toHaveBeenCalled();
    });

    it('does not push files to devices without support', async function () {
        const settings = localPlugin.device.settings;
        const incoming = settings.get_strv('incoming-capabilities');
        settings.set_strv('incoming-capabilities',
            incoming.filter(type => type !== 'kdeconnect.clipboard.file'));
        spyOn(localPlugin.device, 'createTransfer').and.callThrough();
        spyOn(localPlugin._clipboard, 'getImage').and.callThrough();
        spyOn(localPlugin, 'clipboardPush').and.callThrough();

        localPlugin._clipboard.setFile(Utils.getDataUri('album.png'));
        await localPlugin.clipboardPush.calls.mostRecent().returnValue;

        // Image data isn't even read
        const [, contents] = GLib.file_get_contents(
            Utils.getDataPath('album.png'));
        await localPlugin._clipboard.setImage(new GLib.Bytes(contents));
        await localPlugin.clipboardPush.calls.mostRecent().returnValue;

        expect(localPlugin.device.createTransfer).not.toHaveBeenCalled();
        expect(localPlugin._clipboard.getImage).not.toHaveBeenCalled();
        settings.set_strv('incoming-capabilities', incoming);
    });

    it('ignores content that is not text', function () {
        spyOn(remotePlugin, '_onRemoteClipboardChanged');

        remotePlugin.handlePacket(new Core.Packet({
            type: 'kdeconnect.clipboard.connect',
            body: {content: null, timestamp: Date.now()},
        }));

        expect(remotePlugin._onRemoteClipboardChanged).not.toHaveBeenCalled();
    });

    it('receives images into the clipboard as images', async function () {
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(Utils.getDataFile('album.png')));
        spyOn(remotePlugin._clipboard, 'setImage').and.callThrough();
        spyOn(remotePlugin, '_applyImage').and.callThrough();
        spyOn(remotePlugin.device, 'sendPacket').and.callThrough();

        await remotePlugin._handleFile(filePacket('album.png'));
        await remotePlugin._applyImage.calls.mostRecent().returnValue;

        expect(remotePlugin._clipboard.setImage).toHaveBeenCalled();
        await remotePlugin._clipboard.setImage.calls.mostRecent().returnValue;
        expect(remotePlugin._clipboard.content.type).toBe('image');

        // The received image must not be sent back
        await Promise.idle(GLib.PRIORITY_DEFAULT);
        expect(remotePlugin.device.sendPacket).not.toHaveBeenCalled();
    });

    it('receives other files into the clipboard as files', async function () {
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(Utils.getDataFile('vcard-valid.vcf')));
        spyOn(remotePlugin._clipboard, 'setFile').and.callThrough();
        spyOn(remotePlugin.device, 'sendPacket').and.callThrough();

        await remotePlugin._handleFile(filePacket('../../contact.vcf'));

        // The file is saved in the receive directory, with a safe name
        const [uri] = remotePlugin._clipboard.setFile.calls.mostRecent().args;
        const file = Gio.File.new_for_uri(uri);
        const dir = remotePlugin._getReceiveDirectory();
        expect(file.get_basename()).toBe('contact.vcf');
        expect(file.get_parent().get_parent().equal(dir)).toBeTrue();
        expect(file.query_exists(null)).toBeTrue();

        // Previously received files are removed
        const iter = dir.enumerate_children('standard::name',
            Gio.FileQueryInfoFlags.NONE, null);
        expect(iter.next_file(null)).not.toBeNull();
        expect(iter.next_file(null)).toBeNull();

        // The received file must not be sent back
        await Promise.idle(GLib.PRIORITY_DEFAULT);
        expect(remotePlugin.device.sendPacket).not.toHaveBeenCalled();
    });

    it('cancels receiving a file superseded by text', async function () {
        const transfer = pendingTransfer();
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(transfer);
        spyOn(remotePlugin._clipboard, 'setFile');

        const received = remotePlugin._handleFile(filePacket('slow.bin'));
        await Promise.idle(GLib.PRIORITY_DEFAULT);

        remotePlugin.handlePacket(new Core.Packet({
            type: 'kdeconnect.clipboard',
            body: {content: 'newer'},
        }));
        await received;

        expect(transfer.cancel).toHaveBeenCalled();
        expect(remotePlugin._clipboard.setFile).not.toHaveBeenCalled();
        expect(remotePlugin._clipboard.text).toBe('newer');
    });

    it('cancels receiving a file superseded by a local copy', async function () {
        const transfer = pendingTransfer();
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(transfer);
        spyOn(remotePlugin._clipboard, 'setFile');

        const received = remotePlugin._handleFile(filePacket('slow.bin'));
        await Promise.idle(GLib.PRIORITY_DEFAULT);

        remotePlugin._clipboard.text = 'copied locally';
        await received;

        expect(transfer.cancel).toHaveBeenCalled();
        expect(remotePlugin._clipboard.setFile).not.toHaveBeenCalled();
        expect(remotePlugin._clipboard.text).toBe('copied locally');
    });

    it('removes a partially received file, even if destroyed', async function () {
        const transfer = pendingTransfer();
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(transfer);

        const received = remotePlugin._handleFile(filePacket('partial.bin'));
        await Promise.idle(GLib.PRIORITY_DEFAULT);
        const [path] = remotePlugin._receivingDirs;

        // Destroying the plugin cancels its operations
        const cancellable = new Gio.Cancellable();
        cancellable.cancel();
        spyOnProperty(remotePlugin, 'cancellable').and.returnValue(cancellable);

        transfer.cancel();
        await received;

        expect(Gio.File.new_for_path(path).query_exists(null)).toBeFalse();
    });

    it('cancels sending content superseded by the device', function () {
        const transfer = {cancel: jasmine.createSpy('cancel')};
        localPlugin._outgoingTransfer = transfer;

        localPlugin.handlePacket(new Core.Packet({
            type: 'kdeconnect.clipboard',
            body: {content: 'from the device'},
        }));

        expect(transfer.cancel).toHaveBeenCalled();
        expect(localPlugin._outgoingTransfer).toBeNull();
    });

    it('does not forward files received from a device', async function () {
        const dir = localPlugin._getReceiveDirectory().get_child('forward');
        dir.make_directory(null);
        const file = dir.get_child('received.vcf');
        Utils.getDataFile('vcard-valid.vcf').copy(file,
            Gio.FileCopyFlags.NONE, null, null);
        spyOn(localPlugin.device, 'createTransfer');

        await localPlugin._sendFile({type: 'file', uri: file.get_uri()},
            localPlugin._localSerial, localPlugin._remoteSerial);

        expect(localPlugin.device.createTransfer).not.toHaveBeenCalled();
        await localPlugin._removeDirectory(dir);
    });

    it('keeps only current files when clearing the cache', async function () {
        const receiveDir = remotePlugin._getReceiveDirectory();
        const previous = remotePlugin._currentDir;

        for (const name of ['current', 'receiving', 'stale']) {
            const dir = receiveDir.get_child(name);
            dir.make_directory(null);
            dir.get_child('file').create(Gio.FileCreateFlags.NONE, null)
                .close(null);
        }

        remotePlugin._currentDir = receiveDir.get_child('current');
        remotePlugin._receivingDirs.add(
            receiveDir.get_child('receiving').get_path());

        await remotePlugin.clearCache();

        expect(listChildren(receiveDir).sort()).toEqual(['current', 'receiving']);

        remotePlugin._currentDir = previous;
        remotePlugin._receivingDirs.clear();
        await remotePlugin.clearCache();
    });

    it('checks the format of received images from their contents', async function () {
        // JPEG data named as PNG is converted, rather than offered as PNG
        const jpeg = tempFile('photo.png', path => {
            const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB,
                false, 8, 16, 16);
            pixbuf.fill(0x336699ff);
            pixbuf.savev(path, 'jpeg', [], []);
        });
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(jpeg));
        spyOn(remotePlugin._clipboard, 'setImage').and.callThrough();
        spyOn(remotePlugin, '_applyImage').and.callThrough();

        await remotePlugin._handleFile(filePacket('photo.png'));
        await remotePlugin._applyImage.calls.mostRecent().returnValue;

        const [bytes] = remotePlugin._clipboard.setImage.calls.mostRecent().args;
        const signature = bytes.toArray().slice(0, 4);
        expect(Array.from(signature)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    });

    it('receives images in other formats as files', async function () {
        const svg = tempFile('drawing.svgz', path => {
            GLib.file_set_contents(path, '<svg xmlns="http://www.w3.org/2000/svg" ' +
                'width="16" height="16"><rect width="16" height="16"/></svg>');
        });
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(svg));
        spyOn(remotePlugin._clipboard, 'setImage');
        spyOn(remotePlugin._clipboard, 'setFile').and.callThrough();
        spyOn(remotePlugin, '_loadImage').and.callThrough();

        await remotePlugin._handleFile(filePacket('drawing.svgz'));

        // The data isn't even passed to an image loader
        expect(remotePlugin._loadImage).not.toHaveBeenCalled();
        expect(remotePlugin._clipboard.setImage).not.toHaveBeenCalled();
        expect(remotePlugin._clipboard.setFile).toHaveBeenCalled();
    });

    it('receives TIFF images as files', async function () {
        const tiff = tempFile('scan.tiff', path => {
            const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB,
                false, 8, 16, 16);
            pixbuf.fill(0x996633ff);
            pixbuf.savev(path, 'tiff', [], []);
        });
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(tiff));
        spyOn(remotePlugin._clipboard, 'setFile').and.callThrough();
        spyOn(remotePlugin, '_loadImage').and.callThrough();

        await remotePlugin._handleFile(filePacket('scan.tiff'));

        expect(remotePlugin._loadImage).not.toHaveBeenCalled();
        expect(remotePlugin._clipboard.setFile).toHaveBeenCalled();
    });

    it('stops loading an image superseded by the device', async function () {
        const image = tempFile('superseded.png', path => {
            const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB,
                false, 8, 64, 64);
            pixbuf.fill(0x123456ff);
            pixbuf.savev(path, 'png', [], []);
        });
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(image));
        spyOn(remotePlugin._clipboard, 'setImage');

        const loadImage = remotePlugin._loadImage.bind(remotePlugin);
        let path, result;
        spyOn(remotePlugin, '_loadImage').and.callFake((...args) => {
            [path] = remotePlugin._receivingDirs;

            // Newer content arrives while the image is loading
            remotePlugin.handlePacket(new Core.Packet({
                type: 'kdeconnect.clipboard',
                body: {content: 'during load'},
            }));

            const loading = loadImage(...args);
            result = loading.catch(e => e);
            return loading;
        });

        await remotePlugin._handleFile(filePacket('superseded.png'));
        const error = await result;

        expect(error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)).toBeTrue();
        expect(remotePlugin._clipboard.setImage).not.toHaveBeenCalled();
        expect(Gio.File.new_for_path(path).query_exists(null)).toBeFalse();
    });

    it('shortens long names of received files', async function () {
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(Utils.getDataFile('vcard-valid.vcf')));
        spyOn(remotePlugin._clipboard, 'setFile').and.callThrough();

        await remotePlugin._handleFile(filePacket(`${'é'.repeat(300)}.vcf`));

        const [uri] = remotePlugin._clipboard.setFile.calls.mostRecent().args;
        const name = Gio.File.new_for_uri(uri).get_basename();
        expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(200);
        expect(name).toMatch(/^é+\.vcf$/);
    });

    it('rejects a file that can\'t be received', async function () {
        spyOn(remotePlugin.device, 'createTransfer').and.throwError('Failed');
        spyOn(remotePlugin.device, 'rejectTransfer');

        await remotePlugin._handleFile(filePacket('failed.bin'));

        expect(remotePlugin.device.rejectTransfer).toHaveBeenCalled();
    });

    it('cancels receiving a file when the same text is copied again', async function () {
        remotePlugin.handlePacket(new Core.Packet({
            type: 'kdeconnect.clipboard',
            body: {content: 'copied twice'},
        }));
        expect(remotePlugin._clipboard.text).toBe('copied twice');

        const transfer = pendingTransfer();
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(transfer);

        const received = remotePlugin._handleFile(filePacket('slow.bin'));
        await Promise.idle(GLib.PRIORITY_DEFAULT);

        remotePlugin._clipboard._setContent({type: 'text', text: 'copied twice'});
        await received;

        expect(transfer.cancel).toHaveBeenCalled();
    });

    it('does not apply an image superseded by the device', async function () {
        const content = {
            type: 'image',
            checksum: 'superseded',
            uri: Utils.getDataUri('album.png'),
        };
        remotePlugin._pulledContent = content;
        spyOn(remotePlugin._clipboard, 'setImage');

        // A newer file starts being received while the image is read
        const applied = remotePlugin._applyImage(content);
        remotePlugin._remoteSerial++;
        await applied;

        expect(remotePlugin._clipboard.setImage).not.toHaveBeenCalled();
    });

    it('keeps a received file reported again by the clipboard', async function () {
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(Utils.getDataFile('vcard-valid.vcf')));
        spyOn(remotePlugin.device, 'sendPacket').and.callThrough();

        await remotePlugin._handleFile(filePacket('reported.vcf'));
        const dir = remotePlugin._currentDir;
        const content = remotePlugin._clipboard.content;

        // A clipboard manager takes over the clipboard with the same content
        remotePlugin._clipboard._setContent({...content});
        await remotePlugin.clearCache();

        expect(remotePlugin._currentDir).toBe(dir);
        expect(dir.query_exists(null)).toBeTrue();
        expect(remotePlugin.device.sendPacket).not.toHaveBeenCalled();
    });

    it('recognizes contents applied in quick succession', async function () {
        const image = tempFile('quick.png', path => {
            const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB,
                false, 8, 16, 16);
            pixbuf.fill(0x654321ff);
            pixbuf.savev(path, 'png', [], []);
        });
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(image));
        spyOn(remotePlugin, '_applyImage').and.callThrough();
        remotePlugin._clipboard.async = true;

        try {
            await remotePlugin._handleFile(filePacket('quick.png'));
            await remotePlugin._applyImage.calls.mostRecent().returnValue;

            // Text arrives before the image is reported
            remotePlugin.handlePacket(new Core.Packet({
                type: 'kdeconnect.clipboard',
                body: {content: 'right after the image'},
            }));
            const serial = remotePlugin._remoteSerial;
            expect(remotePlugin._pendingEchoes.length).toBe(2);

            await new Promise(resolve => setTimeout(resolve, 50));

            // Neither is mistaken for a local copy
            expect(remotePlugin._remoteSerial).toBe(serial);
            expect(remotePlugin._pendingEchoes).toEqual([]);
        } finally {
            remotePlugin._clipboard.async = false;
        }
    });

    it('stops expecting an image that could not be applied', async function () {
        const content = {
            type: 'image',
            checksum: 'not applied',
            uri: Utils.getDataUri('album.png'),
        };
        remotePlugin._pulledContent = content;
        spyOn(remotePlugin._clipboard, 'setImage').and.resolveTo(false);

        await remotePlugin._applyImage(content);

        expect(remotePlugin._clipboard.setImage).toHaveBeenCalled();
        expect(remotePlugin._pendingEchoes).not.toContain(content);
    });

    it('does not replace a local image with the same image', async function () {
        const [, contents] = GLib.file_get_contents(
            Utils.getDataPath('album.png'));
        await remotePlugin._clipboard.setImage(new GLib.Bytes(contents));
        const local = await remotePlugin._clipboard.getImage();

        const content = {
            type: 'image',
            checksum: local.checksum,
            uri: Utils.getDataUri('album.png'),
        };
        remotePlugin._pulledContent = content;
        spyOn(remotePlugin._clipboard, 'setImage');

        await remotePlugin._applyImage(content);

        expect(remotePlugin._clipboard.setImage).not.toHaveBeenCalled();
    });

    it('hashes large images in chunks', async function () {
        const data = noise(1200 * 1000 * 4);
        const pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(data),
            GdkPixbuf.Colorspace.RGB, true, 8, 1200, 1000, 1200 * 4);

        expect(await getImageChecksum(pixbuf)).toBe(
            referenceChecksum('1200x1000x4', data));
    });

    it('hashes images without the padding between rows', async function () {
        const pixels = [10, 20, 30, 40, 50, 60, 70, 80, 90, 11, 12, 13, 14, 15,
            16, 17, 18, 19];
        const expected = referenceChecksum('3x2x3', new Uint8Array(pixels));

        // The same pixels, with and without padding
        const padded = GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes([
            ...pixels.slice(0, 9), 0, 0, 0, ...pixels.slice(9),
        ]), GdkPixbuf.Colorspace.RGB, false, 8, 3, 2, 12);
        const unpadded = GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(pixels),
            GdkPixbuf.Colorspace.RGB, false, 8, 3, 2, 9);

        expect(await getImageChecksum(padded)).toBe(expected);
        expect(await getImageChecksum(unpadded)).toBe(expected);
    });

    it('hashes large images with padding between rows', async function () {
        const [width, height, rowLength, rowstride] = [1001, 2000, 3003, 3004];
        const data = noise(rowLength * height);
        const padded = new Uint8Array(rowstride * height);

        for (let y = 0; y < height; y++) {
            padded.set(data.subarray(y * rowLength, (y + 1) * rowLength),
                y * rowstride);
        }

        const pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(padded),
            GdkPixbuf.Colorspace.RGB, false, 8, width, height, rowstride);

        expect(await getImageChecksum(pixbuf)).toBe(
            referenceChecksum(`${width}x${height}x3`, data));
    });

    it('cancels receiving a file through its cancellable', async function () {
        const transfer = pendingTransfer();
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(transfer);

        const received = remotePlugin._handleFile(filePacket('slow.bin'));
        await Promise.idle(GLib.PRIORITY_DEFAULT);

        remotePlugin._incomingCancellable.cancel();
        await received;

        expect(transfer.cancel).toHaveBeenCalled();
    });

    it('applies a received image if the local image can\'t be read', async function () {
        const [, contents] = GLib.file_get_contents(
            Utils.getDataPath('album.png'));
        await remotePlugin._clipboard.setImage(new GLib.Bytes(contents));

        const content = {
            type: 'image',
            checksum: 'unreadable',
            uri: Utils.getDataUri('album.png'),
        };
        remotePlugin._pulledContent = content;
        spyOn(remotePlugin._clipboard, 'getImage').and.rejectWith(
            new Error('Unreadable'));
        spyOn(remotePlugin._clipboard, 'setImage').and.resolveTo(true);

        await remotePlugin._applyImage(content);

        expect(remotePlugin._clipboard.setImage).toHaveBeenCalled();
    });

    it('applies text again after the clipboard is cleared', function () {
        const packet = new Core.Packet({
            type: 'kdeconnect.clipboard',
            body: {content: 'before clearing'},
        });

        remotePlugin.handlePacket(packet);
        remotePlugin._clipboard._setContent({type: 'text', text: ''});
        remotePlugin.handlePacket(packet);

        expect(remotePlugin._clipboard.content).toEqual({
            type: 'text',
            text: 'before clearing',
        });
    });

    it('treats a copied image mistaken for an applied one as a copy', async function () {
        const transfer = pendingTransfer();
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(transfer);
        spyOn(remotePlugin, '_checkAppliedImage').and.callThrough();

        const received = remotePlugin._handleFile(filePacket('slow.bin'));
        await Promise.idle(GLib.PRIORITY_DEFAULT);

        // An applied image is expected, but a different image is copied
        remotePlugin._expectEcho({type: 'image', checksum: 'applied'});
        const [, contents] = GLib.file_get_contents(
            Utils.getDataPath('album.png'));
        await remotePlugin._clipboard.setImage(new GLib.Bytes(contents));
        await remotePlugin._checkAppliedImage.calls.mostRecent().returnValue;
        await received;

        expect(transfer.cancel).toHaveBeenCalled();
    });

    it('pushes a copied image mistaken for an applied one', async function () {
        remotePlugin.settings.set_boolean('send-content', true);
        spyOn(remotePlugin, '_checkAppliedImage').and.callThrough();
        spyOn(remotePlugin, '_sendImage').and.resolveTo();

        try {
            // An applied image is expected, but a different image is copied
            remotePlugin._expectEcho({type: 'image', checksum: 'applied'});
            const image = tempFile('copied.png', path => {
                const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB,
                    false, 8, 8, 8);
                pixbuf.fill(0x0f0f0fff);
                pixbuf.savev(path, 'png', [], []);
            });
            const [, contents] = image.load_contents(null);
            await remotePlugin._clipboard.setImage(new GLib.Bytes(contents));
            await remotePlugin._checkAppliedImage.calls.mostRecent().returnValue;
            await Promise.idle(GLib.PRIORITY_DEFAULT);

            expect(remotePlugin._sendImage).toHaveBeenCalledTimes(1);
        } finally {
            remotePlugin.settings.set_boolean('send-content', false);
        }
    });

    it('lets newer content from the device win over checking an image', async function () {
        const [, contents] = GLib.file_get_contents(
            Utils.getDataPath('album.png'));
        const transfer = pendingTransfer();
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(transfer);
        const getImage = remotePlugin._clipboard.getImage.bind(
            remotePlugin._clipboard);
        let received = null;

        // The device starts sending a file while the copied image is read
        spyOn(remotePlugin._clipboard, 'getImage').and.callFake(() => {
            received ??= remotePlugin._handleFile(filePacket('newer.bin'));
            return getImage();
        });
        spyOn(remotePlugin, '_checkAppliedImage').and.callThrough();

        remotePlugin._expectEcho({type: 'image', checksum: 'applied'});
        await remotePlugin._clipboard.setImage(new GLib.Bytes(contents));
        await remotePlugin._checkAppliedImage.calls.mostRecent().returnValue;

        expect(transfer.cancel).not.toHaveBeenCalled();

        remotePlugin._cancelIncomingTransfer();
        await received;
    });

    it('cancels applying an image superseded by the device', async function () {
        const content = {
            type: 'image',
            checksum: 'cancelled',
            uri: Utils.getDataUri('album.png'),
        };
        remotePlugin._pulledContent = content;

        let cancellable = null;
        spyOn(remotePlugin._clipboard, 'setImage').and.callFake((...args) => {
            cancellable = args[2];
            return new Promise(() => {});
        });

        remotePlugin._applyImage(content);
        await new Promise(resolve => setTimeout(resolve, 50));

        remotePlugin.handlePacket(new Core.Packet({
            type: 'kdeconnect.clipboard',
            body: {content: 'newer than the image'},
        }));

        expect(cancellable.is_cancelled()).toBeTrue();
    });

    it('hashes tall, narrow images quickly', async function () {
        const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8,
            1, 2000000);
        pixbuf.fill(0x445566ff);

        const start = Date.now();
        await getImageChecksum(pixbuf);

        // Hashing row by row took several seconds
        expect(Date.now() - start).toBeLessThan(1500);
    });

    it('rejects files that are too large', async function () {
        spyOn(remotePlugin.device, 'createTransfer');
        spyOn(remotePlugin.device, 'rejectTransfer');

        await remotePlugin._handleFile(filePacket('big.bin', 100 * 1024 * 1024));

        expect(remotePlugin.device.rejectTransfer).toHaveBeenCalled();
        expect(remotePlugin.device.createTransfer).not.toHaveBeenCalled();
    });

    it('rejects files when not allowed to pull content', async function () {
        remotePlugin.settings.set_boolean('receive-content', false);
        spyOn(remotePlugin.device, 'createTransfer');
        spyOn(remotePlugin.device, 'rejectTransfer');

        await remotePlugin._handleFile(filePacket('album.png'));

        expect(remotePlugin.device.rejectTransfer).toHaveBeenCalled();
        expect(remotePlugin.device.createTransfer).not.toHaveBeenCalled();
        remotePlugin.settings.set_boolean('receive-content', true);
    });

    it('pushes text copied again after the device sent a file', async function () {
        remotePlugin.handlePacket(new Core.Packet({
            type: 'kdeconnect.clipboard',
            body: {content: 'copied again'},
        }));

        const transfer = pendingTransfer();
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(transfer);
        spyOn(remotePlugin.device, 'sendPacket');
        remotePlugin.settings.set_boolean('send-content', true);

        try {
            const received = remotePlugin._handleFile(filePacket('slow.bin'));
            await Promise.idle(GLib.PRIORITY_DEFAULT);

            // The device has the file, so the text is a new change
            remotePlugin._clipboard._setContent({type: 'text', text: 'copied again'});
            await received;
            await Promise.idle(GLib.PRIORITY_DEFAULT);

            expect(remotePlugin.device.sendPacket).toHaveBeenCalledWith(
                jasmine.objectContaining({
                    type: 'kdeconnect.clipboard',
                    body: {content: 'copied again'},
                }));
        } finally {
            remotePlugin.settings.set_boolean('send-content', false);
        }
    });

    it('applies a file received in full, even if disconnected', async function () {
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(Utils.getDataFile('vcard-valid.vcf')));
        spyOn(remotePlugin._clipboard, 'setFile').and.callThrough();

        // The connection is lost while the file is loaded
        const loadFile = remotePlugin._loadFile.bind(remotePlugin);
        spyOn(remotePlugin, '_loadFile').and.callFake((...args) => {
            remotePlugin.disconnected();
            return loadFile(...args);
        });

        try {
            await remotePlugin._handleFile(filePacket('complete.vcf'));
        } finally {
            remotePlugin.connected();
        }

        expect(remotePlugin._clipboard.setFile).toHaveBeenCalled();
    });

    it('does not push the path of a received file as text', async function () {
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(Utils.getDataFile('vcard-valid.vcf')));
        localPlugin.settings.set_boolean('send-content', true);
        remotePlugin._clipboard.filesAsText = true;

        try {
            // A clipboard that can't hold a file gets its path
            await remotePlugin._handleFile(filePacket('as-text.vcf'));
            const {text} = remotePlugin._clipboard.content;
            expect(text).toMatch(/as-text\.vcf$/);

            // The plugin of another device sees it in the same clipboard
            localPlugin._clipboard.text = text;
            await Promise.idle(GLib.PRIORITY_DEFAULT);

            expect(localPlugin.device.sendPacket).not.toHaveBeenCalled();

            // Nor when connecting
            localPlugin.connected();
            expect(localPlugin.device.sendPacket).not.toHaveBeenCalled();
        } finally {
            remotePlugin._clipboard.filesAsText = false;
            localPlugin.settings.set_boolean('send-content', false);
        }
    });

    it('recognizes images applied in quick succession reported once', async function () {
        const [, contents] = GLib.file_get_contents(
            Utils.getDataPath('album.png'));
        const pixbuf = await decodeImage(new GLib.Bytes(contents));
        const checksum = await getImageChecksum(pixbuf);
        spyOn(remotePlugin, '_checkAppliedImage').and.callThrough();
        const serial = remotePlugin._remoteSerial;

        // Only the last of two applied images is reported
        remotePlugin._expectEcho({type: 'image', checksum: 'first'});
        remotePlugin._expectEcho({type: 'image', checksum: checksum});
        await remotePlugin._clipboard.setImage(new GLib.Bytes(contents));
        await remotePlugin._checkAppliedImage.calls.mostRecent().returnValue;

        expect(remotePlugin._remoteSerial).toBe(serial);
        expect(remotePlugin._pendingEchoes.length).toBe(1);

        // The last image may still be reported itself
        remotePlugin._clipboard.emit('content-changed');
        await remotePlugin._checkAppliedImage.calls.mostRecent().returnValue;

        expect(remotePlugin._remoteSerial).toBe(serial);
        expect(remotePlugin._pendingEchoes).toEqual([]);
    });

    it('keeps a received file reported again while receiving another', async function () {
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(
            mockTransfer(Utils.getDataFile('vcard-valid.vcf')));
        await remotePlugin._handleFile(filePacket('kept.vcf'));
        const dir = remotePlugin._currentDir;
        const content = remotePlugin._clipboard.content;

        // The device starts sending another file
        const transfer = pendingTransfer();
        remotePlugin.device.createTransfer.and.returnValue(transfer);
        const received = remotePlugin._handleFile(filePacket('next.bin'));
        await Promise.idle(GLib.PRIORITY_DEFAULT);

        // A clipboard manager takes over the clipboard with the same file
        remotePlugin._clipboard._setContent({...content});
        await received;
        await remotePlugin.clearCache();

        expect(remotePlugin._currentDir).toBe(dir);
        expect(dir.query_exists(null)).toBeTrue();
    });

    it('ignores an image read superseded by the next applied image', async function () {
        spyOn(remotePlugin, '_checkAppliedImage').and.callThrough();
        const serial = remotePlugin._remoteSerial;

        // Two images are applied, and the first is reported, but the second
        // replaces it while it is read
        remotePlugin._expectEcho({type: 'image', checksum: 'first'});
        remotePlugin._expectEcho({type: 'image', checksum: 'second'});
        spyOn(remotePlugin._clipboard, 'getImage').and.resolveTo(null);
        remotePlugin._clipboard._setContent({type: 'image', mimetype: 'image/png'});
        await remotePlugin._checkAppliedImage.calls.mostRecent().returnValue;

        expect(remotePlugin._remoteSerial).toBe(serial);
        expect(remotePlugin._pendingEchoes).toEqual([
            {type: 'image', checksum: 'second'},
        ]);
        remotePlugin._pendingEchoes = [];
    });

    it('checks the format of a received image before decoding it', async function () {
        const cancellable = new Gio.Cancellable();
        spyOn(GdkPixbuf.Pixbuf, 'new_from_stream_async').and.callThrough();

        await expectAsync(remotePlugin._loadImage(
            Utils.getDataFile('album.png'), 'jpeg', cancellable))
            .toBeRejectedWithError(/Unexpected image format/);
        expect(GdkPixbuf.Pixbuf.new_from_stream_async).not.toHaveBeenCalled();
    });

    it('treats a copied image that can\'t be read as a copy', async function () {
        const transfer = pendingTransfer();
        spyOn(remotePlugin.device, 'createTransfer').and.returnValue(transfer);
        spyOn(remotePlugin, '_checkAppliedImage').and.callThrough();

        const received = remotePlugin._handleFile(filePacket('slow.bin'));
        await Promise.idle(GLib.PRIORITY_DEFAULT);

        // An applied image is still expected, but the copied image is too
        // large to be read
        remotePlugin._expectEcho({type: 'image', checksum: 'applied'});
        spyOn(remotePlugin._clipboard, 'getImage').and.rejectWith(
            new Error('Image is too large'));
        remotePlugin._clipboard._setContent({type: 'image', mimetype: 'image/png'});
        await remotePlugin._checkAppliedImage.calls.mostRecent().returnValue;
        await received;

        expect(transfer.cancel).toHaveBeenCalled();
    });

    it('removes image data once decoded', async function () {
        const [, contents] = GLib.file_get_contents(
            Utils.getDataPath('album.png'));
        await decodeImage(new GLib.Bytes(contents));
        await new Promise(resolve => setTimeout(resolve, 50));

        const names = listChildren(Gio.File.new_for_path(Config.RUNTIMEDIR));
        expect(names.filter(name => name.startsWith('clipboard-image-')))
            .toEqual([]);
    });

    it('does not decode images with too many pixels', async function () {
        const bytes = new GLib.Bytes(Utils.createHugePng(20000, 20000));

        await expectAsync(decodeImage(bytes)).toBeRejectedWithError(
            /too large/);
    });

    it('disables its GActions when disconnected', function () {
        const incoming = {cancel: jasmine.createSpy('cancel')};
        const outgoing = {cancel: jasmine.createSpy('cancel')};
        localPlugin._incomingTransfer = incoming;
        localPlugin._outgoingTransfer = outgoing;

        testRig.setConnected(false);

        // Pending transfers are cancelled
        expect(incoming.cancel).toHaveBeenCalled();
        expect(outgoing.cancel).toHaveBeenCalled();

        expect(localPlugin.device.get_action_enabled('clipboardPush')).toBeFalse();
        expect(localPlugin.device.get_action_enabled('clipboardPull')).toBeFalse();

        expect(remotePlugin.device.get_action_enabled('clipboardPush')).toBeFalse();
        expect(remotePlugin.device.get_action_enabled('clipboardPull')).toBeFalse();
    });
});

