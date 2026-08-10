import assert from "node:assert/strict";
import test from "node:test";

import { capacity, connectionNotice, fullness, linkNotice } from "./usb.ts";
import type { UsbDevice } from "./types.ts";

/** The Galaxy on the bench, as the backend reports it. */
function device(over: Partial<UsbDevice> = {}): UsbDevice {
  return {
    serial: "RFCY71NMVTA",
    name: "SM-F966U1",
    vendorId: 0x04e8,
    productId: 0x6860,
    stage: "ready",
    storages: [],
    link: "USB 2.0",
    linkMbps: 480,
    throttled: true,
    ...over,
  } as UsbDevice;
}

test("a ready device has nothing to explain", () => {
  assert.equal(connectionNotice(device({ stage: "ready" })), null);
});

test("a phone that has not granted access is told what to do, not that it is missing", () => {
  const notice = connectionNotice(device({ stage: "awaitingGrant" }))!;
  assert.match(notice.title, /Unlock SM-F966U1/);
  assert.match(notice.detail, /File transfer/);
  assert.equal(notice.resolves, true);
  // The failure mode we are specifically replacing.
  assert.doesNotMatch(`${notice.title} ${notice.detail}`, /not detected|no device|failed/i);
});

test("a blocked device names the process and explains why it is holding on", () => {
  const notice = connectionNotice(
    device({ stage: "blocked", owner: "ptpcamerad", ownerPid: 412 } as Partial<UsbDevice>)
  )!;
  assert.match(notice.title, /ptpcamerad is holding SM-F966U1/);
  // The specific reason ptpcamerad is worth calling out: it takes the device
  // and then cannot do the thing the person wants.
  assert.match(notice.detail, /can't transfer files/);

  const anonymous = connectionNotice(
    device({ stage: "blocked", owner: null, ownerPid: null } as Partial<UsbDevice>)
  )!;
  assert.match(anonymous.title, /Another app is holding/);
  assert.match(anonymous.detail, /one app can talk to a device at a time/);
});

test("a failure surfaces the underlying message rather than swallowing it", () => {
  const notice = connectionNotice(
    device({ stage: "failed", message: "the device stopped responding" } as Partial<UsbDevice>)
  )!;
  assert.equal(notice.detail, "the device stopped responding");
  assert.equal(notice.resolves, false);
});

test("a slow link states the measured fact without blaming the cable", () => {
  const notice = linkNotice(device())!;
  assert.match(notice.title, /Connected over USB 2\.0/);
  // Concrete cost, and the practical figure rather than the link ratio: MTP
  // does not scale linearly with the link, so promising 10x would be a lie.
  assert.match(notice.detail, /40 MB\/s/);
  assert.match(notice.detail, /twice as fast/);
  assert.doesNotMatch(notice.detail, /10x|ten times/);
  // Offered as a possibility, because USB never tells us which end was the limit.
  assert.match(notice.detail, /If SM-F966U1 supports USB 3/);
  assert.doesNotMatch(notice.detail, /bad cable|faulty|broken/i);
});

test("a full-speed link says nothing at all", () => {
  assert.equal(linkNotice(device({ link: "USB 3.2 Gen 1", linkMbps: 5000, throttled: false })), null);
  // And a device whose link the OS never reported stays quiet too.
  assert.equal(linkNotice(device({ link: null, linkMbps: null, throttled: true })), null);
});

test("capacity reads the way a storage meter should", () => {
  assert.equal(capacity(492.9e9), "493 GB");
  assert.equal(capacity(36.4e9), "36 GB");
  assert.equal(capacity(2.5e9), "2.5 GB");
  assert.equal(capacity(1.5e12), "1.5 TB");
});

test("fullness clamps rather than trusting a device's arithmetic", () => {
  assert.equal(fullness({ freeSpace: 36.4e9, totalCapacity: 492.9e9 }).toFixed(2), "0.93");
  assert.equal(fullness({ freeSpace: 0, totalCapacity: 0 }), 0);
  // Some devices report more free than total; a meter must not overflow.
  assert.equal(fullness({ freeSpace: 200, totalCapacity: 100 }), 0);
});
