<!--
SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect

SPDX-License-Identifier: GPL-2.0-or-later
-->

# GSConnect

> [!NOTE]
> This is a fork of [GSConnect][upstream] that adds sharing of **images and
> files through the clipboard**, as supported by KDE Connect. The changes are
> proposed upstream in [GSConnect#2208][upstream-pr]. Everything below this note
> is the upstream README, and the links in it point to the upstream project.

## About This Fork

The `hidoba` branch is upstream GSConnect plus:

* **Clipboard images and files**: copying a file or an image shares it with
  connected devices, using KDE Connect's `kdeconnect.clipboard.file` packet.
  * Copied images are sent as PNG, and copied files as-is, up to 50 MiB.
  * Received images are placed in the clipboard as images, ready to paste into
    applications. Other received files can be pasted as files, for example in
    Files (Nautilus).
  * Received files are kept in `~/.cache/gsconnect/<device-id>/clipboard/`
    until the next one replaces them.
  * The existing clipboard settings, "send" and "receive content", apply to
    files and images too.
* **Fewer clipboard transfers** ([#2122][issue-2122]): text is only requested
  when the clipboard offers it, and image data is only read when it is sent to a
  device.
* **Clipboard fixes**: the GNOME Shell portal's `GetValue` method works again,
  and text sync works again on other Wayland desktops (via `wl-clipboard`).
* **Version 1000**, so that extensions.gnome.org never replaces the fork with
  an upstream release.

Images and files are only exchanged with devices that support them. Currently
that means the desktop KDE Connect apps (Linux, Windows and macOS) and
GSConnect with these changes. KDE Connect for Android doesn't support them yet,
so it only syncs text. On X11, a received file that isn't an image is pasted as
its path, because GTK 3 can't offer a file list.

### Installing

Building requires `meson`, `ninja` and `gettext`:

```sh
git clone https://github.com/hidoba/gnome-shell-extension-gsconnect.git
cd gnome-shell-extension-gsconnect
meson setup _build
ninja -C _build make-zip
gnome-extensions install --force _build/gsconnect@andyholmes.github.io.zip
```

This replaces an installed GSConnect, and existing pairings and settings are
kept. On Wayland, log out and back in to load the new version.

[upstream]: https://github.com/GSConnect/gnome-shell-extension-gsconnect
[upstream-pr]: https://github.com/GSConnect/gnome-shell-extension-gsconnect/pull/2208
[issue-2122]: https://github.com/GSConnect/gnome-shell-extension-gsconnect/issues/2122

---

[<img src="https://raw.githubusercontent.com/andyholmes/gnome-shell-extensions-badge/master/get-it-on-ego.svg?sanitize=true" alt="Get it on GNOME Extensions" height="100" align="middle">][ego] [<img alt="Available in the Chrome Web Store" src="https://raw.githubusercontent.com/GSConnect/gnome-shell-extension-gsconnect/main/data/images/chrome-badge.png" align="middle" hspace="12"/>][chrome] [<img src="https://raw.githubusercontent.com/GSConnect/gnome-shell-extension-gsconnect/main/data/images/firefox-badge.png" alt="Get the Add-On" align="middle">][firefox]

## Overview

[GSConnect][ego] is a complete implementation of [KDE Connect][kdeconnect]
especially for GNOME Shell with Nautilus, [Chrome][chrome] and
[Firefox][firefox] integration. The KDE Connect team has applications for Linux,
BSD, Android, Sailfish, iOS, macOS and Windows.

With GSConnect you can securely connect to mobile devices and other desktops to:

* Share files, links and text
* Send and receive messages
* Sync clipboard content
* Sync contacts
* Sync notifications
* Control media players
* Control system volume
* Execute predefined commands
* And more…

Please see the **[Wiki][wiki]** for more information about
**[Features][features]** and **[Help][help]**.

## Project Status

GSConnect is now under the GitHub organisation [GSConnect][gsconnect-org].

Please note, this project has migrated from a developer-driven model to a
community-driven model. This means that GSConnect does not have dedicated
developers working on new features or bug fixes. Instead, the project relies on
contributions from its users and distributions that choose to package it.

If you would like to take a more active role in the development and maintenance
of GSConnect, you can start by [triaging new issues][issues],
[fixing confirmed issues][help-wanted] and [reviewing contributions][needs-review].
If you need additional permissions, you may request them from one of the
[current maintainers][people].

## Nightly Builds

For early updaters of GNOME Shell and those that wish to test the upcoming version
of GSConnect, there are automated builds available for [download][nightly-build].
See [Installing from Nightly Build][nightly-install] for installation instructions.

[ego]: https://extensions.gnome.org/extension/1319/gsconnect/
[chrome]: https://chrome.google.com/webstore/detail/gsconnect/jfnifeihccihocjbfcfhicmmgpjicaec
[firefox]: https://addons.mozilla.org/firefox/addon/gsconnect/
[kdeconnect]: https://userbase.kde.org/KDEConnect
[wiki]: https://github.com/GSConnect/gnome-shell-extension-gsconnect/wiki/
[features]: https://github.com/GSConnect/gnome-shell-extension-gsconnect/wiki/Features
[help]: https://github.com/GSConnect/gnome-shell-extension-gsconnect/wiki/Help

[gsconnect-org]: https://github.com/GSConnect
[issues]: https://github.com/GSConnect/gnome-shell-extension-gsconnect/issues
[help-wanted]: https://github.com/GSConnect/gnome-shell-extension-gsconnect/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22
[needs-review]: https://github.com/GSConnect/gnome-shell-extension-gsconnect/pulls?q=is%3Apr+is%3Aopen+label%3A%22needs+review%22
[people]: https://github.com/orgs/GSConnect/people
[nightly-build]: https://nightly.link/GSConnect/gnome-shell-extension-gsconnect/workflows/main/main/gsconnect@andyholmes.github.io.zip
[nightly-install]: https://github.com/GSConnect/gnome-shell-extension-gsconnect/wiki/Installation#install-from-nightly-build
