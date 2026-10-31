// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Utils from '../fixtures/utils.js';

import Config from '../config.js';
const Core = await import(`file://${Config.PACKAGE_DATADIR}/service/core.js`);
const {getImageChecksum} = await import(
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
        start() {
            return new Promise((resolve, reject) => {
                this.cancel = jasmine.createSpy('cancel').and.callFake(() => {
                    reject(new Gio.IOErrorEnum({
                        code: Gio.IOErrorEnum.CANCELLED,
                        message: 'Cancelled',
                    }));
                });
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

        await remotePlugin._handleFile(filePacket('drawing.svgz'));

        expect(remotePlugin._clipboard.setImage).not.toHaveBeenCalled();
        expect(remotePlugin._clipboard.setFile).toHaveBeenCalled();
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
        expect(remotePlugin._pendingEcho).toBeNull();
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
        const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, true, 8,
            1200, 1000);
        pixbuf.fill(0x12345678);

        const expected = GLib.compute_checksum_for_bytes(
            GLib.ChecksumType.SHA256, pixbuf.read_pixel_bytes());

        expect(await getImageChecksum(pixbuf)).toBe(`1200x1000:${expected}`);
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

