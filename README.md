# SIP chatbot server

Node.js/TypeScript server za SIP chatbot i scraper-e podataka sa sajta
Elektronskog fakulteta u Nišu.

## Pokretanje

Potrebne promenljive okruženja u `.env`:

```text
OPENAI_API_KEY=...
OPENAI_MODEL=...
CORS_ORIGIN=http://localhost:4200
PORT=3000
```

Instaliranje, razvoj i produkcioni build:

```text
npm install
npm run dev
npm run build
npm start
```

Socket.IO server podrazumevano sluša na portu `3000`. Provera rada dostupna je
na `GET /health`.

Klijent šalje događaj `askQuestion` sa poljima `question`,
`conversationHistory` i opcionim `context`. Odgovor stiže kroz
`questionResponse`.

## Baza podataka (RAG)

PostgreSQL 16 sa ekstenzijama `pgvector`, `pg_trgm` i `unaccent`. Ista baza
opslužuje obe grane RAG sistema: vektorsku/leksičku pretragu nad tekstualnim
sadržajem (dokumentacija, konkursi) i determinističke SQL upite nad
strukturiranim podacima (raspored ispita, raspored časova, kalendar).

```text
npm run db:up        # podiže Postgres u Dockeru
npm run db:migrate   # primenjuje migracije iz db/migrations
npm run db:check     # provera ekstenzija, tabela i pgvector operatora
npm run db:down      # gasi kontejner (podaci ostaju u volumenu)
```

Podešavanja se čitaju iz `.env` (šablon je `.env.example`); `DATABASE_URL` je
obavezan. Migracije su numerisani `.sql` fajlovi u `db/migrations/`, primenjuju
se redom, svaka u svojoj transakciji, a primenjene se pamte u tabeli
`schema_migrations` zajedno sa SHA-256 otiskom sadržaja — izmena već primenjene
migracije je greška, umesto toga se dodaje nova.

Strukturirani podaci se namerno **ne** embeduju: raspored ispita ima blizu
12.000 termina koji su tabela, a ne proza, pa se nad njima izvršava SQL sa
filterima umesto vektorske pretrage. Time se dobija tačan odgovor uz bitno
manju potrošnju tokena.

## Ručno ažuriranje podataka

```text
npm run update:dokumentacija -- 2025/2026
npm run update:konkursi -- 2025/2026
npm run update:kalendar -- 2025/2026
npm run update:exams -- 2025/2026
npm run update:raspored-casova
```

- `dokumentacija-<godina>.json` sadrži samo studentske administrativne postupke
  i dokumente: upis, overu semestra, ispis, izbor predmeta/modula, obrasce,
  završni rad, praksu, školarinu i prijavu ispita.
- `konkursi-<godina>.json` sadrži samo promovisane studentske prilike: prakse,
  kurseve, stipendije, razmene, radionice, takmičenja, konferencije, programe i
  oglase za posao.
- `raspored-casova/` sadrži OAS i MAS rasporede po semestru i modulu. Rasporedi
  prve godine već su deo ovog scraper-a i uključuju mapiranje indeksa na grupe.

Svi scraper-i osim rasporeda časova prihvataju školsku godinu kao obavezan
argument; raspored časova je sam pronalazi sa stranica. Kod dokumentacije i
konkursa objave koje pripadaju drugoj godini odbacuju se, dok se objave bez
godine tretiraju kao opšte samo kada pripadaju traženoj temi. Kalendar i
raspored ispita godinu koriste za adresu stranice na portalu.

## Periodično ažuriranje

Jedno izvršavanje svih pet scraper-a (raspored časova, kalendar aktivnosti,
raspored ispita, konkursi, dokumentacija) za tekuću školsku godinu. Ako jedan
scraper ne uspe, ostali se svejedno izvrše:

```text
npm run scheduler:once
```

Pokretanje periodičnog scheduler-a:

```text
npm run scheduler
```

Podrazumevani termin je svakog dana u `03:15`, vremenska zona
`Europe/Belgrade`. Menja se promenljivom `SIP_SCRAPER_CRON`, na primer:

```text
SIP_SCRAPER_CRON=0 4 * * * 
```

Scheduler sam određuje tekuću školsku godinu.

## Struktura

```text
src/server.ts                 Socket.IO server i health endpoint
src/db/                       konekcija, migracije i provera baze
db/migrations/                SQL migracije
src/events/                   WebSocket događaji
src/services/                 OpenAI servis
src/prompts/                  sistemski i korisnički prompt
src/index.ts                  periodični scheduler
src/scraper/                  izvršne scraper skripte
src/scraper/lib/              zajednička ekstrakcija i klasifikacija
data/                         generisani JSON podaci
```

Fajl `srp.traineddata` je lokalni OCR model za srpski jezik i koristi se pri
čitanju vertikalnog teksta iz PDF rasporeda.
