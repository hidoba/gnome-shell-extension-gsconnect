// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';


/**
 * The maximum number of pixels of a clipboard image, to limit memory use.
 */
export const MAX_IMAGE_PIXELS = 100 * 1000 * 1000;


/**
 * Decode image data into a pixbuf.
 *
 * @param {GLib.Bytes} bytes - Encoded image data
 * @returns {GdkPixbuf.Pixbuf} A pixbuf
 */
export function decodeImage(bytes) {
    const loader = new GdkPixbuf.PixbufLoader();
    let tooLarge = false;

    loader.connect('size-prepared', (_loader, width, height) => {
        tooLarge = width * height > MAX_IMAGE_PIXELS;
    });

    try {
        loader.write_bytes(bytes);
    } finally {
        loader.close();
    }

    if (tooLarge)
        throw new Error('Image is too large');

    const pixbuf = loader.get_pixbuf();

    if (pixbuf === null)
        throw new Error('Failed to decode image');

    return pixbuf.apply_embedded_orientation() ?? pixbuf;
}


/**
 * Encode a pixbuf as PNG data.
 *
 * @param {GdkPixbuf.Pixbuf} pixbuf - A pixbuf
 * @returns {GLib.Bytes} PNG data
 */
export function encodePng(pixbuf) {
    const [, buffer] = pixbuf.save_to_bufferv('png', [], []);

    return new GLib.Bytes(buffer);
}


/**
 * Get a checksum for the pixel data of a pixbuf.
 *
 * This is used to recognize an image regardless of how it was encoded.
 *
 * @param {GdkPixbuf.Pixbuf} pixbuf - A pixbuf
 * @returns {string} A checksum
 */
export function getImageChecksum(pixbuf) {
    // Normalize to 8-bit RGBA, which has no padding between rows
    if (!pixbuf.has_alpha)
        pixbuf = pixbuf.add_alpha(false, 0, 0, 0);

    const checksum = new GLib.Checksum(GLib.ChecksumType.SHA256);
    checksum.update(new TextEncoder().encode(`${pixbuf.width}x${pixbuf.height}:`));
    checksum.update(pixbuf.read_pixel_bytes().toArray());

    return checksum.get_string();
}
