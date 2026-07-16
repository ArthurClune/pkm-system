import { expect, test } from "vitest";
import { UID_ALPHABET, UID_BYTE_LENGTH, bytesToUid } from "./uidCore";

test("alphabet has exactly 64 symbols (so 64 divides 256 uniformly)", () => {
  expect(UID_ALPHABET.length).toBe(64);
  expect(new Set(UID_ALPHABET).size).toBe(64);
});

test("maps each byte to the alphabet character at byte & 63", () => {
  expect(bytesToUid([0])).toBe(UID_ALPHABET[0]);
  expect(bytesToUid([63])).toBe(UID_ALPHABET[63]);
  // 255 & 63 === 63: the top two bits are discarded, not overflowed
  expect(bytesToUid([255])).toBe(UID_ALPHABET[63]);
  // 64 & 63 === 0: wraps back to the start of the alphabet
  expect(bytesToUid([64])).toBe(UID_ALPHABET[0]);
});

test("concatenates one character per input byte, in order", () => {
  const bytes = [0, 1, 2, 63, 64, 65];
  expect(bytesToUid(bytes)).toBe(bytes.map((b) => UID_ALPHABET[b & 63]).join(""));
});

test("is pure: same input always produces the same output", () => {
  const bytes = new Uint8Array([10, 20, 30]);
  expect(bytesToUid(bytes)).toBe(bytesToUid(bytes));
});

test("UID_BYTE_LENGTH matches the shell's requested random-byte count", () => {
  expect(UID_BYTE_LENGTH).toBe(16);
});
