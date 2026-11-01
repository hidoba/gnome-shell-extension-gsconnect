// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import Config from '../../config.js';
const {
    decodeImage,
    encodePng,
    getImageChecksum,
} = await import(`file://${Config.PACKAGE_DATADIR}/service/utils/image.js`);


const Component = GObject.registerClass({
    GTypeName: 'MockClipboard',
    Properties: {
        'text': GObject.ParamSpec.string(
            'text',
            'Text Content',
            'The current text content of the clipboard',
            GObject.ParamFlags.READWRITE,
            ''
        ),
    },
    Signals: {
        'content-changed': {
            flags: GObject.SignalFlags.RUN_FIRST,
        },
    },
}, class MockClipboard extends GObject.Object {

    get content() {
        if (this._content === undefined)
            this._content = {type: 'text', text: this.text};

        return this._content;
    }

    get text() {
        if (this._text === undefined)
            this._text = 'initial';

        return this._text;
    }

    set text(content) {
        // Like the real component, the text is set even if unchanged
        if (this.text !== content) {
            this._text = content;
            this.notify('text');
        }

        this._setContent({type: 'text', text: content});
    }

    /**
     * Whether changes are reported asynchronously, like the real component.
     *
     * @type {boolean}
     */
    get async() {
        return this._async ?? false;
    }

    set async(async) {
        this._async = async;
    }

    _setContent(content, image = null) {
        this._content = content;
        this._image = image;

        if (content.type !== 'text' && this._text !== '') {
            this._text = '';
            this.notify('text');
        }

        if (!this.async) {
            this.emit('content-changed');
            return;
        }

        // Report the content set after a delay, like a round trip to the
        // session clipboard, even if changed again in the meantime
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
            const current = [this._content, this._image];
            this._content = content;
            this._image = image;
            this.emit('content-changed');
            [this._content, this._image] = current;

            return GLib.SOURCE_REMOVE;
        });
    }

    getImage() {
        return Promise.resolve(this._image);
    }

    async setImage(bytes) {
        const pixbuf = await decodeImage(bytes);

        this._setContent({type: 'image', mimetype: 'image/png'}, {
            bytes: await encodePng(pixbuf),
            checksum: await getImageChecksum(pixbuf),
        });

        return true;
    }

    setFile(uri) {
        const content = {type: 'file', uri: uri};
        this._setContent(content);

        return content;
    }
});

export default Component;
