# Easy Stems for iOS: building and sending to TestFlight

The app lives in `ios/`. Nothing binary is committed: the Xcode project is
generated from `ios/project.yml` with XcodeGen, in CI and on a Mac.

## Every push

The `iOS` workflow builds the app for the simulator on every change under
`ios/`. That proves it compiles. No Apple account is needed for that.

## Sending a build to TestFlight

Run the `iOS` workflow by hand (Actions → iOS → Run workflow) with
**Upload to TestFlight** ticked. It needs these repository secrets once:

| Secret | What it is |
| --- | --- |
| `APPLE_TEAM_ID` | The studio's team id, `SGQVTNFK4Q`. |
| `IOS_DIST_P12` | An **Apple Distribution** certificate and its private key as a base64 `.p12`. |
| `IOS_DIST_PASSWORD` | The password that `.p12` was exported with. |
| `ASC_KEY_P8` | An App Store Connect API key (`.p8` text, or base64 of it), role App Manager or Admin. |
| `ASC_KEY_ID` | That key's id. |
| `ASC_ISSUER_ID` | The issuer id shown on the same App Store Connect page. |

### Making the `.p12`

Apple Distribution certificates are made at developer.apple.com →
Certificates. With the certificate (`distribution.cer`) and the private key
that signed its request (`distribution-key.pem`):

```sh
openssl x509 -in distribution.cer -inform DER -out distribution.pem
openssl pkcs12 -export -legacy -inkey distribution-key.pem -in distribution.pem \
  -out distribution.p12 -passout pass:CHOOSE_A_PASSWORD
base64 -i distribution.p12 | pbcopy      # paste as IOS_DIST_P12
```

If the certificate was made on a Mac through Keychain Access, export it from
there as a `.p12` instead and base64 that.

### Making the API key

App Store Connect → Users and Access → Integrations → App Store Connect API
→ Team keys → **+**. Download the `.p8` (only offered once). Paste its text
as `ASC_KEY_P8`, the Key ID as `ASC_KEY_ID`, the Issuer ID as `ASC_ISSUER_ID`.

### The app record

App Store Connect → Apps → **+** → New App: platform iOS, name Easy Stems,
bundle id `com.amanorsac.easystems` (register it first under Identifiers at
developer.apple.com if it is not offered), SKU `easystems`. Without this
record the upload is refused.

Once uploaded, the build appears under the app's TestFlight tab after
Apple processes it (ten minutes or so). Add testers there.

## Building on a Mac

```sh
brew install xcodegen
cd ios && xcodegen generate && open EasyStems.xcodeproj
```
