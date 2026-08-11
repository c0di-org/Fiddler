//! What a phone actually calls itself.
//!
//! Run with a phone plugged in, unlocked, and set to File transfer:
//!
//!     pkill -x fiddler; pkill ptpcamerad
//!     cargo run --example device_name
//!
//! Both pkills matter. MTP allows one connection per device, so a running
//! Fiddler holds it; and macOS's `ptpcamerad` claims every PTP device on
//! enumeration without being able to transfer from an Android.
//!
//! This exists because `SAMSUNG_Android` turned up in the sidebar and there was
//! no way to tell from the outside whether that was the USB product string, the
//! MTP model, or a fallback — three different bugs with three different fixes.

use mtp_rs::mtp::MtpDevice;

// `current_thread`: the crate enables tokio's `rt` and `macros` but not
// `rt-multi-thread`, and all device I/O is serialised onto one thread anyway.
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let found = MtpDevice::list_devices()?;
    if found.is_empty() {
        eprintln!("no MTP device — is it plugged in, unlocked, and set to File transfer?");
        return Ok(());
    }

    for info in &found {
        println!("=== USB descriptor (readable without opening) ===");
        println!("  manufacturer : {:?}", info.manufacturer);
        println!("  product      : {:?}", info.product);
        println!("  serial       : {:?}", info.serial_number);
        println!("  ids          : {:04x}:{:04x}", info.vendor_id, info.product_id);

        let Some(serial) = info.serial_number.clone() else { continue };

        // `ptpcamerad` respawns on every enumeration — including the one this
        // probe just did — so a single attempt loses the race almost every
        // time. The app's poll loop wins it by simply coming back, so do that.
        let mut opened = None;
        for attempt in 0..40 {
            match MtpDevice::open_by_serial(&serial).await {
                Ok(device) => {
                    println!("  (opened on attempt {})", attempt + 1);
                    opened = Some(device);
                    break;
                }
                Err(e) if e.is_exclusive_access() => {
                    let _ = std::process::Command::new("pkill").arg("ptpcamerad").status();
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                }
                Err(e) => {
                    eprintln!("  could not open: {e}");
                    break;
                }
            }
        }
        let Some(device) = opened else {
            eprintln!("  never got the device — something else is holding it");
            continue;
        };

        let d = device.device_info();
        println!("=== MTP DeviceInfo (needs a session) ===");
        println!("  manufacturer : {:?}", d.manufacturer);
        println!("  model        : {:?}", d.model);
        println!("  version      : {:?}", d.device_version);
        println!("  serial       : {:?}", d.serial_number);

        // `mtp_rs::DeviceInfo` is a reduced view — manufacturer, model, serial
        // and version, nothing else. The full PTP DeviceInfo carries
        // `device_properties_supported`, which is where 0xD402
        // (DeviceFriendlyName, the name someone set in Settings) would have to
        // be looked up, and MtpDevice does not expose it. So this probe answers
        // only the first question: is `model` any better than what we show now?
        let _ = device.close().await;
    }

    Ok(())
}
