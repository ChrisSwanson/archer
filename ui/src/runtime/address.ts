/** The page's address and state identity: the live page's by default; the static playground entry selects its own. */
export interface AddressCodec {
  encodeAddress(href: string): string;
  decodeAddress(href: string): string;
  browserStateKey(key: string): string;
}

export let encodeAddress = (href: string): string => href;
export let decodeAddress = (href: string): string => href;
export let browserStateKey = (key: string): string => key;

/** Called once by an entry before it renders; consumers read these bindings at call time. */
export function selectAddressCodec(codec: AddressCodec): void {
  encodeAddress = codec.encodeAddress;
  decodeAddress = codec.decodeAddress;
  browserStateKey = codec.browserStateKey;
}
