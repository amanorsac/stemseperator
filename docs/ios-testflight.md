# Easy Stems for iOS: building and sending to TestFlight

The app lives in `ios/`. The Xcode project is generated from
`ios/project.yml` with XcodeGen, so nothing binary is committed.

Every push under `ios/` builds the app for the simulator. That needs no
Apple account. Sending a build to TestFlight follows the studio's macOS
signing standard and needs three things done once.

## 1. Let this repository see the secrets

The studio's Apple secrets live on the `Amanorsac-Studio` organisation.
This repository is owned by the personal account `amanorsac`, and
organisation secrets never reach a personal account's repositories. They
resolve to empty strings. Pick one:

- **Transfer the repository into the organisation** (Settings → General →
  Transfer ownership → `Amanorsac-Studio`). GitHub redirects the old URLs,
  so the desktop app's model downloads keep working. Then check the org
  secrets' visibility is "All repositories", since this repository is public.
- **Or add them as repository secrets** here (Settings → Secrets and
  variables → Actions), with the same names and values as the org ones.

| Secret | Contents |
| --- | --- |
| `APPLE_TEAM_ID` | `SGQVTNFK4Q` |
| `ASC_KEY_P8` | the text of `AuthKey_XXXXXXXX.p8`, or base64 of it |
| `ASC_KEY_ID` | the `XXXXXXXX` from that filename |
| `ASC_ISSUER_ID` | the UUID from App Store Connect → Users and Access → Integrations |
| `APPLE_DIST_P12` | base64 of the Apple Distribution .p12 built in step 2 |
| `APPLE_DIST_PASSWORD` | that .p12's password |

Paste contents, never filenames. The API key needs the Admin role, or App
Manager with access to Certificates, Identifiers and Profiles, so Xcode can
register the bundle id and make the App Store profile itself.

## 2. Build the Apple Distribution .p12

`distribution-cert.pem` and `key.pem` are in
`C:\Users\amano\Documents\Amanorsac Studio\Security\`. The flags are the
same as the standard's and are not optional. The intermediate for Apple
Distribution is Apple's WWDR G3 authority, not the Developer ID one.

```bash
curl -o AppleWWDRCAG3.cer https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer
openssl x509 -inform DER -in AppleWWDRCAG3.cer -out wwdr.pem

openssl pkcs12 -export -legacy \
  -macalg sha1 -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES \
  -inkey key.pem \
  -in distribution-cert.pem \
  -certfile wwdr.pem \
  -name "Apple Distribution: Stephen Amanor Sackey (SGQVTNFK4Q)" \
  -out apple_distribution.p12 \
  -passout "pass:THEPASSWORD"

# must print:  MAC: sha1, Iteration 2048
openssl pkcs12 -legacy -in apple_distribution.p12 -passin "pass:THEPASSWORD" -info -nokeys 2>&1 >/dev/null | grep MAC

base64 -w0 apple_distribution.p12 > apple_distribution.b64   # paste the contents as APPLE_DIST_P12
```

## 3. Create the app record

App Store Connect → Apps → **+** → New App. Platform iOS, name Easy Stems,
bundle id `com.amanorsac.easystems`, SKU `easystems`. If the bundle id is
not offered yet, register it at developer.apple.com → Identifiers first.
Apple's API cannot create app records, so this one step is by hand.

## Sending a build

Actions → iOS → Run workflow, with **Sign and upload to TestFlight** ticked.
The run fails at its first step, naming each missing secret, if the
repository cannot see one. Once uploaded, the build shows under the app's
TestFlight tab after Apple processes it, usually within fifteen minutes.

## Building on a Mac

```sh
brew install xcodegen
cd ios && xcodegen generate && open EasyStems.xcodeproj
```
