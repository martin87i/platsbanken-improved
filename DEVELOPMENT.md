# Utveckling – Platsbanken Improved

Kommandon jag använder för att testa, släppa och underhålla tillägget.
Kör alla kommandon i tilläggets mapp (där `manifest.json` ligger).

## Testa lokalt

**Starta en ren Firefox med tillägget (laddar om automatiskt vid sparning)**
```powershell
npx web-ext run
```
Stoppa med `Ctrl+C`.

**Öppna en viss sida direkt**
```powershell
npx web-ext run --start-url "https://arbetsformedlingen.se/platsbanken"
```

**Använd min vanliga Firefox-profil (stäng Firefox först)**
```powershell
npx web-ext run --firefox-profile=default-release --keep-profile-changes
```

**Manuellt temporärt tillägg**
`about:debugging` → Den här Firefox → Läs in tillfälligt tillägg → välj `manifest.json`.
- Ändring i `manifest.json` eller `_locales/`: klicka **Läs om**.
- Ändring i `content.js`: uppdatera sidan (Ctrl+Shift+R vid behov).
- Ändring i `popup.html`/`popup.js`: stäng och öppna popupen.

## Kontrollera koden

**Samma kontroller som AMO gör vid uppladdning**
```powershell
npx web-ext lint
```

**Bygg en zip för manuell uppladdning**
```powershell
npx web-ext build
```
Zip-filen hamnar i `web-ext-artifacts/`. Ladda inte upp den till git.

## Git

**Spara ändringar på GitHub (utan att släppa till AMO)**
```powershell
git add .
git commit -m "Beskrivning av ändringen"
git push
```

**Push avvisas ("fetch first")**
```powershell
git pull --rebase origin main
git push
```

## Släppa ny version till AMO

Workflowet `.github/workflows/publish.yml` körs när en tagg som börjar på `v` pushas.

1. Höj `version` i `manifest.json` (t.ex. `2.69.1`). AMO avvisar en version som redan finns.
2. Committa och pusha:
   ```powershell
   git add .
   git commit -m "Version 2.69.1"
   git push
   ```
3. Skapa och pusha taggen. Den måste vara exakt `v` + versionen i manifestet:
   ```powershell
   git tag v2.69.1
   git push origin v2.69.1
   ```
4. Följ körningen under fliken **Actions** på GitHub (eller `gh run watch`).
   Grön bock betyder att versionen skickades in, inte att den är godkänd.
   Mozilla mejlar när granskningen är klar.

**Ångra en felaktig tagg**
```powershell
git tag -d v2.69.1
git push origin --delete v2.69.1
```

## Att komma ihåg

- Add-on-ID:t i `manifest.json` (`browser_specific_settings.gecko.id`) får aldrig ändras. Det är det som gör att AMO ser en ny version som en uppdatering av samma tillägg.
- Secrets för AMO ligger i repots Settings → Secrets and variables → Actions:
  `AMO_JWT_ISSUER` och `AMO_JWT_SECRET`. Nycklarna skapas under Developer Hub → Tools → Manage API Keys.
- Skriv aldrig nycklar eller lösenord i den här filen eller i koden.
