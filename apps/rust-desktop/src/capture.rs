//! A picture of what a webview window shows: the research screenshot, and
//! the packaged smoke's proof that the page rendered.
//!
//! On Linux WebKitGTK renders it itself (`webkit_web_view_get_snapshot`), so
//! it works under X11 and Wayland alike and the package links no
//! screen-capture library. On macOS and Windows xcap captures the window.

use tauri::WebviewWindow;

/// Why there is no picture.
#[derive(Debug)]
pub enum Failure {
    /// The window is not on screen, so there is nothing to capture.
    NotShown,
    /// Capturing failed; the text says how.
    Failed(String),
}

#[cfg(target_os = "linux")]
pub fn window_image(window: &WebviewWindow) -> Result<image::RgbaImage, Failure> {
    use std::sync::mpsc;
    use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};

    if !window.is_visible().unwrap_or(false) {
        return Err(Failure::NotShown);
    }
    let (sender, receiver) = mpsc::channel();
    // Runs on the interface thread; the snapshot arrives on its main loop.
    window
        .with_webview(move |webview| {
            webview.inner().snapshot(
                SnapshotRegion::Visible,
                SnapshotOptions::NONE,
                None::<&webkit2gtk::gio::Cancellable>,
                move |result| {
                    let _ = sender.send(
                        result
                            .map_err(|error| error.to_string())
                            .and_then(from_surface),
                    );
                },
            );
        })
        .map_err(|error| Failure::Failed(error.to_string()))?;
    receiver
        .recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|_| Failure::Failed("the webview did not deliver a snapshot".into()))?
        .map_err(Failure::Failed)
}

#[cfg(target_os = "linux")]
fn from_surface(surface: cairo::Surface) -> Result<image::RgbaImage, String> {
    let image = cairo::ImageSurface::try_from(surface)
        .map_err(|_| "the snapshot is not an image surface".to_owned())?;
    let opaque = match image.format() {
        cairo::Format::ARgb32 => false,
        cairo::Format::Rgb24 => true,
        other => return Err(format!("unexpected snapshot pixel format {other:?}")),
    };
    let (width, height, stride) = (image.width(), image.height(), image.stride());
    let mut converted = None;
    image
        .with_data(|data| {
            converted = rgba_from_cairo(
                data,
                width as usize,
                height as usize,
                stride as usize,
                opaque,
            );
        })
        .map_err(|error| format!("the snapshot pixels are unavailable: {error}"))?;
    converted.ok_or_else(|| format!("the snapshot is not a {width} × {height} image"))
}

/// Cairo's pixels as straight RGBA. Cairo stores each pixel as one
/// native-endian 32-bit word: alpha (unused in RGB24), red, green, blue,
/// with the colours premultiplied by alpha; rows are `stride` bytes apart.
#[cfg(any(target_os = "linux", test))]
fn rgba_from_cairo(
    data: &[u8],
    width: usize,
    height: usize,
    stride: usize,
    opaque: bool,
) -> Option<image::RgbaImage> {
    if width == 0
        || height == 0
        || stride < width * 4
        || data.len() < stride * (height - 1) + width * 4
    {
        return None;
    }
    let mut pixels = Vec::with_capacity(width * height * 4);
    for row in 0..height {
        let start = row * stride;
        let (words, _) = data[start..start + width * 4].as_chunks::<4>();
        for word in words {
            let word = u32::from_ne_bytes(*word);
            let alpha = if opaque { 255 } else { word >> 24 };
            let straight = |shift: u32| -> u8 {
                let premultiplied = (word >> shift) & 0xff;
                match alpha {
                    0 => 0,
                    255 => premultiplied as u8,
                    _ => ((premultiplied * 255 + alpha / 2) / alpha).min(255) as u8,
                }
            };
            pixels.extend_from_slice(&[straight(16), straight(8), straight(0), alpha as u8]);
        }
    }
    image::RgbaImage::from_raw(width as u32, height as u32, pixels)
}

#[cfg(not(target_os = "linux"))]
pub fn window_image(window: &WebviewWindow) -> Result<image::RgbaImage, Failure> {
    let title = window
        .title()
        .map_err(|error| Failure::Failed(error.to_string()))?;
    let pid = std::process::id();
    let candidate = xcap::Window::all()
        .map_err(|error| Failure::Failed(error.to_string()))?
        .into_iter()
        .find(|item| {
            item.pid().ok() == Some(pid) && item.title().ok().as_deref() == Some(title.as_str())
        })
        .ok_or(Failure::NotShown)?;
    candidate
        .capture_image()
        .map_err(|error| Failure::Failed(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(alpha: u32, red: u32, green: u32, blue: u32) -> [u8; 4] {
        (alpha << 24 | red << 16 | green << 8 | blue).to_ne_bytes()
    }

    #[test]
    fn cairo_pixels_become_straight_rgba_row_by_row() {
        // Two rows of two pixels, each row padded to 12 bytes.
        let mut data = Vec::new();
        data.extend(word(255, 200, 100, 50));
        data.extend(word(128, 64, 32, 0)); // half-transparent, premultiplied
        data.extend([9; 4]); // padding
        data.extend(word(0, 0, 0, 0));
        data.extend(word(255, 1, 2, 3));
        data.extend([9; 4]);
        let image = rgba_from_cairo(&data, 2, 2, 12, false).unwrap();
        assert_eq!((image.width(), image.height()), (2, 2));
        assert_eq!(image.get_pixel(0, 0).0, [200, 100, 50, 255]);
        assert_eq!(image.get_pixel(1, 0).0, [128, 64, 0, 128]);
        assert_eq!(image.get_pixel(0, 1).0, [0, 0, 0, 0]);
        assert_eq!(image.get_pixel(1, 1).0, [1, 2, 3, 255]);
    }

    #[test]
    fn rgb24_pixels_are_opaque_whatever_the_unused_byte_holds() {
        let data = word(7, 10, 20, 30);
        let image = rgba_from_cairo(&data, 1, 1, 4, true).unwrap();
        assert_eq!(image.get_pixel(0, 0).0, [10, 20, 30, 255]);
    }

    #[test]
    fn too_few_pixels_for_the_size_is_no_image() {
        assert!(rgba_from_cairo(&[0; 15], 2, 2, 8, false).is_none());
        assert!(rgba_from_cairo(&[0; 16], 2, 2, 4, false).is_none());
        assert!(rgba_from_cairo(&[], 0, 0, 0, false).is_none());
        // The last row needs no padding after it.
        assert!(rgba_from_cairo(&[0; 20], 2, 2, 12, false).is_some());
    }
}
