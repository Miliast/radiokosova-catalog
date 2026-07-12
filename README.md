# radiokosova-catalog

Stündlich gebauter Podcast-Katalog für die Dëgjo-App. Eine GitHub Action lädt
alle Feeds aus `seeds.json`, normalisiert sie und veröffentlicht
`public/catalog-v1.json` über GitHub Pages. Die App lädt statt 18 RSS-Feeds
nur noch diese eine Datei. Konzept und Begründungen: siehe
`docs/catalog-backend-konzept.md` und `docs/catalog-umsetzungsplan.md` im
App-Repo.

## Einmaliges Setup (~10 Minuten)

Alle Kommandos in DIESEM Ordner (`catalog-repo/`) ausführen.

**1. Lokal testen** (Node ≥ 20):

```bash
npm install          # erzeugt auch package-lock.json — wird mitcommittet!
node build-catalog.mjs
```

Prüfen: `public/catalog-v1.json` existiert, ~19 Shows, Größe plausibel.

**2. Öffentliches Repo anlegen und pushen** (mit GitHub CLI `gh`, oder
manuell auf github.com ein leeres öffentliches Repo `radiokosova-catalog`
anlegen):

```bash
git init -b main
git add -A
git commit -m "catalog builder"
gh repo create radiokosova-catalog --public --source . --push
```

**3. GitHub Pages aktivieren:** Repo auf github.com → Settings → Pages →
Source: "Deploy from a branch" → Branch `main`, Ordner `/public`? Falls nur
`/ (root)` und `/docs` angeboten werden: Source auf "GitHub Actions" lassen
geht auch — einfachste Variante, die immer funktioniert: Branch `main`,
Folder `/ (root)`, dann ist die Datei unter
`https://<USER>.github.io/radiokosova-catalog/public/catalog-v1.json`
erreichbar. URL im Browser prüfen.

**4. Action scharf schalten:** Repo → Actions → "build-catalog" → "Run
workflow" (manueller Testlauf). Danach läuft sie automatisch stündlich um :17.

**5. App verdrahten:** Im App-Repo in `src/data/config.ts` die Konstante
`CATALOG_URL` auf die Pages-URL aus Schritt 3 setzen. Solange sie leer ist,
ist das Feature aus und die App verhält sich wie bisher.

## Betrieb

Show hinzufügen/entfernen → `seeds.json` editieren, committen, pushen,
optional "Run workflow" für sofort. Kein App-Release nötig.

Rote Action = Validierung fehlgeschlagen oder Builder-Crash; der alte
Katalog bleibt online, GitHub schickt dir eine Mail. Einzelne tote Feeds
sind KEIN Fehler: Selbstheilung behält den letzten funktionierenden Stand
der Show (steht im Action-Log unter "Feed issues").

Achtung: GitHub pausiert Cron-Workflows in Repos ohne Aktivität nach 60
Tagen (Mail kommt vorher). Ein Klick auf "Enable" reaktiviert.
