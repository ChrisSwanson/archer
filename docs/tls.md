# HTTPS & Browser Trust

Archer serves HTTP on loopback by default. Access from another device needs HTTPS and browser trust. Network setup creates a local certificate, preserves other global service settings and restarts Archer after you confirm at a terminal.

```sh
archer network-access
```

Open the printed address on your other device, then enter the pairing code. Run `archer pair` for a new code. `archer network-access off` returns to access from this computer only and keeps the certificate.

## Trust the certificate

Copy only the public `ca/ca-cert.pem` to each browser device. Compare its SHA-256 fingerprint with the value Archer prints. Keep private keys on the Archer server.

| Device | Import the public CA |
| --- | --- |
| iPhone / iPad | Install the profile in **Settings → General → VPN & Device Management**, then enable it in **General → About → Certificate Trust Settings**. |
| Android | Search Settings for **CA certificate** and install it as a CA. Menu names vary by device. |
| macOS | Add it in **Keychain Access**, open the certificate and choose **Trust → Always Trust**. |
| Windows | Open `certmgr.msc`; import into the current user's **Trusted Root Certification Authorities → Certificates**. |
| Linux / Firefox | Import under the browser's certificate settings, as an authority trusted to identify websites. Firefox can also use the OS's third-party roots setting. |

Restart the browser and use the exact hostname or IP Archer printed.

## Common problems and fixes

- **Browser says the issuer is unknown.** Import the public CA on that device. On iOS, also enable website trust; in Firefox, import the CA or enable third-party OS roots.
- **Certificate does not match the address.** Open the issued hostname/IP. Bind addresses such as `0.0.0.0` and `::` are not browser destinations. Provision a new certificate if the destination changes.
- **Another device cannot connect.** Run `archer network-access` on the server and check that both devices can reach the printed LAN address and port.
- **Startup reports `tls_required`.** Enable network access, or configure a trusted PEM certificate/key. Startup does not generate certificates or fall back to HTTP for a network bind.
- **Old tabs stop reconnecting after enabling HTTPS.** Save drafts before switching. Open the new HTTPS link; HTTP and HTTPS have separate browser preferences and draft storage.
- **Certificate expired.** Provision in a new directory, trust the new public CA, then install the renewed material. A restart reloads the existing PEM paths; changing paths requires a stop/start.

## Manage certificates yourself

OpenSSL must be installed on the server. This command prints paths, expiry, fingerprint and a global service configuration block; it does not overwrite files, change configuration or import trust.

```sh
archer tls setup --host 192.168.1.42
```

Merge the printed settings into the global `[service]` table (or the matching named service), preserving other settings. Trusted existing certificates use absolute `tls_cert` and `tls_key` paths. Keep keys out of project folders and Git.

`archer restart` validates TLS before replacing the service and preserves its URL, projects and current PEM paths. To adopt different paths, save drafts, stop Archer and start it with the new configuration. Verify access before retiring the old CA.

Certificate import instructions: [Apple](https://support.apple.com/en-us/102390), [Android](https://support.google.com/pixelphone/answer/2844832), [Windows](https://learn.microsoft.com/en-us/windows-server/identity/ad-cs/inspect-certificates-manage-certificate-stores), [Firefox](https://support.mozilla.org/en-US/kb/automatically-trust-third-party-certificates).
