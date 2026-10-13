# Igelpflege – lokale iPhone-Web-App

Verwaltung von Igeln in der Pflegestelle. Alle Daten (Igel, Gewichte, Fotos, Medikation, Kotproben, Tierarzt, Futter) liegen **ausschließlich in der lokalen Datenbank des iPhones**. Die App macht keine Netzwerkaufrufe mit Nutzerdaten, hat kein Tracking und lädt keine Bibliotheken von fremden Servern.

## Funktionen
- **Igel-Stammdaten:** Name, Pflege-Nr., Status, Geschlecht, Alter, Fund- und Finderdaten, Zustand, Abgang und Notizen
- **Fotos:** Kamera oder Mediathek, Titelbild wählen, Fotos teilen. Bilder werden automatisch verkleinert.
- **Gewicht:** Wiegeprotokoll mit Diagramm, Zielgewicht-Linie, Zunahme seit Aufnahme und Ø g/Tag über 7 Tage
- **Medizin:** Medikation mit Dosis, Gaben pro Tag und Dauer, Gaben abhaken. Dazu Kotproben mit Parasitenbefund und Kontrolltermin sowie Tierarztbesuche mit Kosten und nächstem Termin.
- **Futter:** Futterprotokoll. Futter und Menge der letzten Fütterung werden vorbelegt.
- **Heute:** offene Medikamentengaben, fälliges Wiegen, Termine und Kontrollen der nächsten 3 Tage, fehlende Fütterungen, Backup-Erinnerung
- **PDF-Pflegeprotokoll** pro Igel
- **Backup / Wiederherstellung** als JSON-Datei, inklusive Fotos

## Auf GitHub Pages veröffentlichen (kostenlos)
1. Auf github.com ein neues Repository anlegen, z. B. `igelpflege`.
2. Den **Inhalt** dieses Ordners hochladen: „Add file“ → „Upload files“. Dabei die Ordner `icons` und `vendor` mitnehmen. `index.html` muss im Hauptverzeichnis liegen.
3. Im Repository unter **Settings → Pages** bei „Source“ den Eintrag „Deploy from a branch“ wählen, Branch `main`, Ordner `/ (root)`, dann speichern.
4. Nach etwa 1 Minute ist die App erreichbar unter `https://<dein-github-name>.github.io/igelpflege/`.

## Auf dem iPhone installieren
1. Die Adresse in **Safari** öffnen.
2. Auf **Teilen** tippen, dann **„Zum Home-Bildschirm“** wählen und hinzufügen.
3. Die App **nur noch über das Homescreen-Icon** starten. Die Daten gehören zu dieser Homescreen-App, nicht zum Safari-Tab.

Nach dem ersten Start läuft die App komplett offline.

## Wichtig: Datensicherung
- Wenn du die App vom Home-Bildschirm löschst, sind auch die Daten gelöscht.
- Regelmäßig unter **Einstellungen → Backup erstellen** sichern und **„In Dateien sichern“** wählen, z. B. iCloud Drive. Der Reiter „Heute“ erinnert nach 7 Tagen.
- Ein Backup lässt sich auch auf ein anderes iPhone einspielen.

## Updates
1. Geänderte Dateien ins Repository hochladen.
2. In `sw.js` die Versionsnummer erhöhen, z. B. `igelpflege-v2`.
3. Die App lädt das Update beim nächsten Start mit Netz. Die Daten bleiben dabei erhalten.

## Lokal testen
```bash
cd igelpflege
python3 -m http.server 8000
```
Dann `http://localhost:8000` im Browser öffnen.

## Dateien
| Datei | Zweck |
|---|---|
| `index.html` | Grundgerüst |
| `app.js` | gesamte App-Logik (IndexedDB, Ansichten, Formulare, PDF, Backup) |
| `styles.css` | Gestaltung inkl. Dark Mode |
| `sw.js` | Service Worker für den Offline-Betrieb |
| `manifest.webmanifest` | App-Name und Icons |
| `vendor/` | jsPDF 4.2.1 und jsPDF-AutoTable 5.0.8 (MIT-Lizenz), lokal eingebunden |
| `icons/` | App-Icons |
