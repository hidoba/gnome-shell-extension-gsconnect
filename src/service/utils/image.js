// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';


/**
 * The maximum size of a file or image shared through the clipboard, which is
 * the same as the default of KDE Connect.
 */
export const MAX_FILE_SIZE = 50 * 1024 * 1024;


/**
 * The maximum number of pixels of a received image, to limit memory use.
 */
export const MAX_IMAGE_PIXELS = 25 * 1000 * 1000;


/**
 * The image formats accepted from devices, by GdkPixbuf format name, with the
 * signature their data starts with (%null matches any byte). Other formats
 * are received as files, without being decoded.
 */
const IMAGE_SIGNATURES = {
    png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    jpeg: [0xff, 0xd8, 0xff],
    gif: [0x47, 0x49, 0x46, 0x38],
    webp: [
        0x52, 0x49, 0x46, 0x46, null, null, null, null,
        0x57, 0x45, 0x42, 0x50,
    ],
    bmp: [0x42, 0x4d],
};


/**
 * The number of bytes hashed at a time, before yielding to the main loop.
 */
const CHECKSUM_CHUNK_SIZE = 4 * 1024 * 1024;


/**
 * Get the format of an image file from the signature its data starts with,
 * without passing it to an image loader.
 *
 * @param {Gio.File} file - A file
 * @param {Gio.Cancellable} [cancellable] - A cancellable
 * @returns {Promise<string|null>} The GdkPixbuf name of an accepted format, or
 *   %null if the file is not an image in an accepted format
 */
export async function getImageFormat(file, cancellable = null) {
    const stream = await file.read_async(GLib.PRIORITY_DEFAULT, cancellable);

    try {
        const bytes = await new Promise((resolve, reject) => {
            stream.read_bytes_async(12, GLib.PRIORITY_DEFAULT, cancellable,
                (_stream, res) => {
                    try {
                        resolve(stream.read_bytes_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
        const header = bytes.toArray();

        for (const [name, signature] of Object.entries(IMAGE_SIGNATURES)) {
            if (header.length >= signature.length &&
                signature.every((byte, i) => byte === null || byte === header[i]))
                return name;
        }

        return null;
    } finally {
        stream.close(null);
    }
}


/**
 * Load the contents of a file.
 *
 * @param {Gio.File} file - A file
 * @param {Gio.Cancellable} [cancellable] - A cancellable
 * @returns {Promise<GLib.Bytes>} The contents
 */
export function loadBytes(file, cancellable = null) {
    return new Promise((resolve, reject) => {
        file.load_bytes_async(cancellable, (_file, res) => {
            try {
                resolve(file.load_bytes_finish(res)[0]);
            } catch (e) {
                reject(e);
            }
        });
    });
}


/**
 * Get the format and dimensions of an image file, without decoding it.
 *
 * @param {Gio.File} file - An image file
 * @param {Gio.Cancellable} [cancellable] - A cancellable
 * @returns {Promise<Array>} The format (or %null if unsupported), the width
 *   and the height of the image
 */
export function getImageInfo(file, cancellable = null) {
    return new Promise((resolve, reject) => {
        GdkPixbuf.Pixbuf.get_file_info_async(file.get_path(), cancellable,
            (_source, res) => {
                try {
                    resolve(GdkPixbuf.Pixbuf.get_file_info_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}


/**
 * Decode image data into a pixbuf, in a worker thread.
 *
 * Data larger than {@link MAX_FILE_SIZE} is rejected without being decoded.
 *
 * @param {GLib.Bytes} bytes - Encoded image data
 * @param {Gio.Cancellable} [cancellable] - A cancellable
 * @returns {Promise<GdkPixbuf.Pixbuf>} A pixbuf
 */
export async function decodeImage(bytes, cancellable = null) {
    if (bytes.get_size() > MAX_FILE_SIZE)
        throw new Error('Image is too large');

    const stream = Gio.MemoryInputStream.new_from_bytes(bytes);
    const pixbuf = await new Promise((resolve, reject) => {
        GdkPixbuf.Pixbuf.new_from_stream_async(stream, cancellable,
            (_source, res) => {
                try {
                    resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });

    return pixbuf.apply_embedded_orientation() ?? pixbuf;
}


/**
 * Encode a pixbuf as PNG data, in a worker thread.
 *
 * @param {GdkPixbuf.Pixbuf} pixbuf - A pixbuf
 * @param {Gio.Cancellable} [cancellable] - A cancellable
 * @returns {Promise<GLib.Bytes>} PNG data
 */
export async function encodePng(pixbuf, cancellable = null) {
    const stream = Gio.MemoryOutputStream.new_resizable();

    await new Promise((resolve, reject) => {
        pixbuf.save_to_streamv_async(stream, 'png', [], [], cancellable,
            (_source, res) => {
                try {
                    resolve(GdkPixbuf.Pixbuf.save_to_stream_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });

    stream.close(null);

    return stream.steal_as_bytes();
}


/**
 * Get a checksum for the pixel data of a pixbuf.
 *
 * This is used to recognize an image regardless of how it was encoded. The
 * rows are hashed without the padding between them, in chunks, to avoid
 * blocking the main loop for large images.
 *
 * @param {GdkPixbuf.Pixbuf} pixbuf - A pixbuf
 * @param {Gio.Cancellable} [cancellable] - A cancellable
 * @returns {Promise<string>} A checksum
 */
export async function getImageChecksum(pixbuf, cancellable = null) {
    const {width, height, rowstride} = pixbuf;
    const channels = pixbuf.n_channels;
    const rowLength = width * channels * pixbuf.bits_per_sample / 8;
    const pixels = pixbuf.read_pixel_bytes();
    const checksum = new GLib.Checksum(GLib.ChecksumType.SHA256);

    // Rows without padding are hashed as a whole
    const rows = rowstride === rowLength
        ? [[0, rowLength * height]]
        : Array.from({length: height}, (_, y) => [y * rowstride, rowLength]);

    let hashed = 0;

    for (const [offset, length] of rows) {
        for (let start = 0; start < length; start += CHECKSUM_CHUNK_SIZE) {
            if (hashed >= CHECKSUM_CHUNK_SIZE) {
                hashed = 0;

                await new Promise(resolve => {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        resolve();
                        return GLib.SOURCE_REMOVE;
                    });
                });

                cancellable?.set_error_if_cancelled();
            }

            const chunk = Math.min(CHECKSUM_CHUNK_SIZE, length - start);
            checksum.update(GLib.Bytes.new_from_bytes(pixels, offset + start,
                chunk).toArray());
            hashed += chunk;
        }
    }

    return `${width}x${height}x${channels}:${checksum.get_string()}`;
}
