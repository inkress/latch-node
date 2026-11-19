/**
 * `ip_in_cidr` (Latch only; Inkress has no such operator). The attribute is an IP address string, the condition
 * values are CIDR strings (`10.0.0.0/8`, `2001:db8::/32`) or bare addresses (a /32 or /128). Anything that does not
 * parse is simply not a match.
 *
 * Strict syntax, so a value means one thing everywhere: IPv4 is four decimal parts without leading zeros (`010` is
 * ambiguous between decimal and octal and is refused); IPv6 follows RFC 4291 text forms, including `::` and a
 * trailing dotted IPv4, with no zone id (`%eth0`) and no brackets; a prefix is decimal digits without sign or leading
 * zeros. Host bits after the prefix are ignored (`10.1.2.3/8` is `10.0.0.0/8`). An IPv4-mapped IPv6 attribute
 * (`::ffff:10.0.0.1`, how dual-stack sockets report IPv4 clients) is treated as the IPv4 address; an IPv4 rule never
 * matches a real IPv6 address and the reverse.
 */

type Family = 4 | 6;

interface Address {
  readonly family: Family;
  readonly bits: bigint;
}

const DECIMAL_PART = /^(0|[1-9][0-9]{0,2})$/;
const HEX_GROUP = /^[0-9A-Fa-f]{1,4}$/;
const FAMILY_BITS = { 4: 32, 6: 128 } as const;

function parseIpv4(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let bits = 0n;
  for (const part of parts) {
    if (!DECIMAL_PART.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    bits = (bits << 8n) | BigInt(octet);
  }
  return bits;
}

/** Hex groups of one side of `::` (or of the whole address); a trailing dotted IPv4 counts as two groups. */
function parseGroups(text: string, allowIpv4Tail: boolean): number[] | null {
  if (text === "") return [];
  const pieces = text.split(":");
  const groups: number[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i] as string;
    if (allowIpv4Tail && i === pieces.length - 1 && piece.includes(".")) {
      const tail = parseIpv4(piece);
      if (tail === null) return null;
      groups.push(Number(tail >> 16n), Number(tail & 0xffffn));
    } else {
      if (!HEX_GROUP.test(piece)) return null;
      groups.push(Number.parseInt(piece, 16));
    }
  }
  return groups;
}

function parseIpv6(text: string): bigint | null {
  const halves = text.split("::");
  if (halves.length > 2) return null;
  let groups: number[];
  if (halves.length === 1) {
    const all = parseGroups(text, true);
    if (all === null || all.length !== 8) return null;
    groups = all;
  } else {
    const left = parseGroups(halves[0] as string, false);
    const right = parseGroups(halves[1] as string, true);
    if (left === null || right === null || left.length + right.length > 7) return null;
    groups = [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
  }
  return groups.reduce((bits, group) => (bits << 16n) | BigInt(group), 0n);
}

function parseAddress(text: string): Address | null {
  if (text.includes(":")) {
    const bits = parseIpv6(text);
    return bits === null ? null : { family: 6, bits };
  }
  const bits = parseIpv4(text);
  return bits === null ? null : { family: 4, bits };
}

/** The IPv4 address inside an IPv4-mapped IPv6 address (::ffff:0:0/96), else `null`. */
function mappedIpv4(address: Address): bigint | null {
  return address.family === 6 && address.bits >> 32n === 0xffffn ? address.bits & 0xffff_ffffn : null;
}

/**
 * `true` when `address` is an IP inside `cidr`. Invalid input on either side is `false`. IPv4-mapped forms are the
 * same address as the IPv4 they carry on both sides: `::ffff:10.0.0.1` is in `10.0.0.0/8`, `10.0.0.1` is in
 * `::ffff:10.0.0.0/104` and in `::ffff:0:0/96` (a mapped network with a prefix of 96 or more is the IPv4 network with
 * the prefix minus 96; a shorter prefix stays an IPv6 network, and there a bare IPv4 address is matched as its mapped form,
 * so `10.0.0.1` is in `::/0` exactly as `::ffff:10.0.0.1` is).
 */
export function ipInCidr(address: string, cidr: string): boolean {
  const parsedAddress = parseAddress(address);
  if (parsedAddress === null) return false;
  const slash = cidr.indexOf("/");
  const parsedNetwork = parseAddress(slash === -1 ? cidr : cidr.slice(0, slash));
  if (parsedNetwork === null) return false;
  let prefix: number = FAMILY_BITS[parsedNetwork.family];
  if (slash !== -1) {
    const prefixText = cidr.slice(slash + 1);
    if (!DECIMAL_PART.test(prefixText)) return false;
    prefix = Number(prefixText);
    if (prefix > FAMILY_BITS[parsedNetwork.family]) return false;
  }
  let network = parsedNetwork;
  const mappedNetwork = mappedIpv4(network);
  if (mappedNetwork !== null && prefix >= 96) {
    network = { family: 4, bits: mappedNetwork };
    prefix -= 96;
  }
  const mappedAddress = mappedIpv4(parsedAddress);
  // The two spellings of one address must give one answer: an IPv4 address is also ::ffff:a.b.c.d for an IPv6 network.
  const candidate: Address =
    network.family === 4 && mappedAddress !== null
      ? { family: 4, bits: mappedAddress }
      : network.family === 6 && parsedAddress.family === 4
        ? { family: 6, bits: (0xffffn << 32n) | parsedAddress.bits }
        : parsedAddress;
  if (candidate.family !== network.family) return false;
  const hostBits = BigInt(FAMILY_BITS[network.family] - prefix);
  return candidate.bits >> hostBits === network.bits >> hostBits;
}
