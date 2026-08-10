//! The `mtp://` address space.
//!
//! ```text
//! mtp://RFCY71NMVTA                       the device itself — its storages are the listing
//! mtp://RFCY71NMVTA/65537                 a storage root
//! mtp://RFCY71NMVTA/65537/DCIM/Camera     a folder on that storage
//! ```
//!
//! The serial is the USB serial from `MtpDeviceInfo`, which is readable without
//! opening the device — so a path stays valid across the whole connection
//! sequence, including the stretch where the phone hasn't granted anything yet.
//!
//! Components are not escaped. MTP filenames cannot contain `/` (the spec
//! forbids it, and `NewObjectInfo` rejects it), so splitting on `/` is exact and
//! the path stays readable in the breadcrumb.

/// A parsed `mtp://` address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MtpPath {
    /// USB serial of the device.
    pub serial: String,
    /// The storage, absent when the address is the device root.
    pub storage: Option<u64>,
    /// Path within the storage, `/`-prefixed, or empty at the storage root.
    pub rel: String,
}

impl MtpPath {
    /// The name to show for this address: the last component, else the storage,
    /// else the device.
    pub fn leaf(&self) -> Option<&str> {
        self.rel.rsplit('/').find(|part| !part.is_empty())
    }

    /// This address with `name` appended as a child.
    pub fn child(&self, name: &str) -> String {
        match self.storage {
            Some(storage) => format!("mtp://{}/{}{}/{name}", self.serial, storage, self.rel),
            None => format!("mtp://{}/{name}", self.serial),
        }
    }
}

/// Parse an `mtp://` address, or `None` if this isn't one.
pub fn parse(path: &str) -> Option<MtpPath> {
    let rest = path.strip_prefix("mtp://")?;
    let (serial, rest) = rest.split_once('/').unwrap_or((rest, ""));
    if serial.is_empty() {
        return None;
    }
    let (storage, rel) = match rest.split_once('/') {
        Some((head, tail)) => (head, tail),
        None => (rest, ""),
    };
    // A device root has no storage segment at all. A storage segment that isn't
    // a number is a malformed address rather than a folder name, because the
    // first segment after the serial is always the storage.
    let storage = if storage.is_empty() { None } else { Some(storage.parse().ok()?) };
    let rel = rel.trim_end_matches('/');
    Some(MtpPath {
        serial: serial.to_string(),
        storage,
        rel: if rel.is_empty() { String::new() } else { format!("/{rel}") },
    })
}

/// Build an address for a path within a storage.
pub fn format(serial: &str, storage: u64, rel: &str) -> String {
    format!("mtp://{serial}/{storage}{}", rel.trim_end_matches('/'))
}

/// Build the address of a device root.
pub fn device_root(serial: &str) -> String {
    format!("mtp://{serial}/")
}

/// Unix seconds for an MTP datetime.
///
/// Devices report a civil datetime with no zone, and Android sends local time.
/// Treating it as UTC can shift a displayed timestamp by the device's offset,
/// which is the same trade libmtp makes — the alternative is guessing a zone we
/// were never told.
pub fn unix_seconds(dt: &mtp_rs::mtp::DateTime) -> i64 {
    let (y, m) = (dt.year as i64, dt.month as i64);
    // Days from civil (Howard Hinnant): shift the year to start in March so the
    // leap day lands at the end and the month-length series has no special case.
    let y = y - if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + dt.day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    days * 86_400 + dt.hour as i64 * 3_600 + dt.minute as i64 * 60 + dt.second as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(year: u16, month: u8, day: u8, hour: u8, minute: u8, second: u8) -> mtp_rs::mtp::DateTime {
        mtp_rs::mtp::DateTime { year, month, day, hour, minute, second }
    }

    #[test]
    fn non_mtp_paths_are_left_alone() {
        assert_eq!(parse("/Users/codi/Developer"), None);
        assert_eq!(parse("fiddler://abc/photos"), None);
        assert_eq!(parse("mtp://"), None);
        assert_eq!(parse("mtp:///65537"), None);
    }

    #[test]
    fn device_root_has_no_storage() {
        let p = parse("mtp://RFCY71NMVTA").unwrap();
        assert_eq!(p.serial, "RFCY71NMVTA");
        assert_eq!(p.storage, None);
        assert_eq!(p.rel, "");
        // The trailing-slash form is what device_root builds, and must agree.
        assert_eq!(parse(&device_root("RFCY71NMVTA")).unwrap(), p);
    }

    #[test]
    fn storage_root_and_folders() {
        let root = parse("mtp://RFCY71NMVTA/65537").unwrap();
        assert_eq!(root.storage, Some(65537));
        assert_eq!(root.rel, "");
        assert_eq!(root.leaf(), None);

        let folder = parse("mtp://RFCY71NMVTA/65537/DCIM/Camera").unwrap();
        assert_eq!(folder.storage, Some(65537));
        assert_eq!(folder.rel, "/DCIM/Camera");
        assert_eq!(folder.leaf(), Some("Camera"));
    }

    #[test]
    fn trailing_slashes_do_not_create_empty_components() {
        assert_eq!(parse("mtp://S/1/DCIM/").unwrap().rel, "/DCIM");
        assert_eq!(parse("mtp://S/1/").unwrap().rel, "");
    }

    #[test]
    fn names_with_spaces_and_percent_survive() {
        // No escaping, so the odd characters people actually have in filenames
        // must round-trip exactly.
        let p = parse("mtp://S/1/My Stuff/100% real.jpg").unwrap();
        assert_eq!(p.rel, "/My Stuff/100% real.jpg");
        assert_eq!(p.leaf(), Some("100% real.jpg"));
    }

    #[test]
    fn child_builds_a_parseable_address() {
        let folder = parse("mtp://S/65537/DCIM").unwrap();
        let child = folder.child("Camera");
        assert_eq!(child, "mtp://S/65537/DCIM/Camera");
        assert_eq!(parse(&child).unwrap().rel, "/DCIM/Camera");

        let storage_root = parse("mtp://S/65537").unwrap();
        assert_eq!(storage_root.child("DCIM"), "mtp://S/65537/DCIM");

        let device = parse("mtp://S").unwrap();
        assert_eq!(device.child("65537"), "mtp://S/65537");
    }

    #[test]
    fn format_round_trips() {
        assert_eq!(format("S", 65537, "/DCIM/Camera"), "mtp://S/65537/DCIM/Camera");
        assert_eq!(format("S", 65537, ""), "mtp://S/65537");
    }

    #[test]
    fn epoch_conversion_matches_known_instants() {
        assert_eq!(unix_seconds(&dt(1970, 1, 1, 0, 0, 0)), 0);
        assert_eq!(unix_seconds(&dt(2000, 3, 1, 0, 0, 0)), 951_868_800);
        // A leap day, the case the March-shifted year exists to get right.
        assert_eq!(unix_seconds(&dt(2024, 2, 29, 12, 0, 0)), 1_709_208_000);
        assert_eq!(unix_seconds(&dt(2026, 8, 10, 7, 54, 0)), 1_786_348_440);
    }
}
