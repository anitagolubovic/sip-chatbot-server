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

## Istorija razgovora

Front šalje `conversationHistory` uz svako pitanje, ali se modelu ne prosleđuje
cela: `src/services/conversation.ts` zadržava poslednja tri para
pitanje-odgovor, skraćuje svaku poruku na 160 tokena i ceo blok drži ispod 600
tokena, izbacujući najstarije poruke kada budžet ne dozvoljava sve. Sistemske i
prazne poruke se odbacuju. Toliko konteksta pokriva kontrapitanje i jedno-dva
nadovezivanja, a duži razgovor bi se samo ponavljao u svakom zahtevu.

Istorija se koristi i pre poziva modelu: kada se pitanje oslanja na razgovor
(kraće od pet reči, počinje veznikom ili sadrži zamenicu — „a u junu?“,
„Matematika 1“ kao odgovor na kontrapitanje), upitu ka bazi se pridružuje
prethodno korisnikovo pitanje. Spajanje je lokalno, nad `toSearchForm()`
oblikom, i ne troši nijedan token modela. Korisniku se i dalje šalje njegovo
originalno pitanje; dopunjen je samo upit za pretragu.

Ispis `[tokeni]` posle svakog odgovora razdvaja ulaz na prompt, kontekst,
pitanje i istoriju, pa se vidi koliko istorija zaista košta.

```text
npm run test:conversation
```

## Preprocesiranje teksta

Student pita na srpskom, ćirilicom ili latinicom, često bez dijakritike i sa
poneskom greškom u kucanju. Korpus je pretežno ćirilički. Zato se **i podaci i
pitanje** provlače kroz istu funkciju `toSearchForm()` koja sve svodi na jedan
kanonski oblik: latinica, bez dijakritike, mala slova.

```text
npm run test:preprocessing   # 20 testova nad modulima za obradu teksta
npm run data:report          # izveštaj o kvalitetu podataka u data/
```

Redosled obrade:

```text
cleanUnicode()        NFC, popravka mešanog pisma, nevidljivi znaci, interpunkcija
splitGluedText()      razdvajanje slepljenih rečenica, URL-ovi se ne diraju
normalizeParagraphs() čišćenje i uklanjanje uzastopnih duplikata
buildChunks()         čankovanje po strukturi uz zaglavlje i preklapanje
toSearchForm()        transliteracija + skidanje dijakritike + mala slova
```

Zašto baš ovako:

- **Mešano pismo** je stvarna šteta u podacima — u `konkursi` postoji `wеб`
  napisano latiničnim `w` i ćiriličnim `еб`, što ne može da se otkuca ni na
  jednoj tastaturi, pa ga nijedna pretraga ne nalazi. Popravka se radi po reči,
  na osnovu pisma kojem pripada većina njenih slova; reč čije se pismo ne može
  odrediti ostaje netaknuta.
- **Skidanje dijakritike** usput rešava najčešću grešku u kucanju: `č`, `ć` i
  `c` postaju isto slovo, pa `cacak` pogađa `Чачак`.
- **Čankovanje** čuva pasuse celim i pakuje ih do budžeta od 400 tokena. Svaki
  čank nosi zaglavlje `[kategorija | naslov | godina]` da bi ostao razumljiv
  kada se izvuče iz svog dokumenta. Predugačak pasus se deli po rečenicama, a
  nabrajanje bez tačke po granicama reči — budžet je garancija, ne preporuka.
- **Brojanje tokena** ide kroz `cl100k_base`, isti tokenizator koji koristi
  `text-embedding-3-small`. Ćirilica troši oko dvostruko više tokena po znaku
  od latinice, pa procena po broju karaktera ne bi bila upotrebljiva.

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
src/preprocessing/            čišćenje, transliteracija i čankovanje teksta
src/events/                   WebSocket događaji
src/services/                 OpenAI servis, pretraga i istorija razgovora
src/prompts/                  sistemski i korisnički prompt
src/index.ts                  periodični scheduler
src/scraper/                  izvršne scraper skripte
src/scraper/lib/              zajednička ekstrakcija i klasifikacija
data/                         generisani JSON podaci
```

Fajl `srp.traineddata` je lokalni OCR model za srpski jezik i koristi se pri
čitanju vertikalnog teksta iz PDF rasporeda.
