-- Provera podataka o rasporedu ispita posle "npm run db:ingest:exams".
-- Pokretanje: docker exec -i sip-chatbot-db psql -U sip -d sip_chatbot -f - < db/queries/exams_check.sql
\set year '2025/2026'

-- 1. Pregled po rokovima. Ocekivano: 7 rokova, po 1691 ispit, 0 ispita bez datuma.
SELECT exam_period,
       count(*)                       AS ispita,
       min(exam_date)                 AS pocetak,
       max(exam_date)                 AS kraj,
       count(*) - count(exam_time)    AS bez_vremena,
       count(*) - count(exam_date)    AS bez_datuma
FROM exams
WHERE academic_year = :'year'
GROUP BY exam_period
ORDER BY min(exam_date);

-- 2. Tacan pogodak naziva predmeta, dedupovan po terminu.
--    Ovo je oblik upita koji ruter koristi za "kada je Matematika 1?".
SELECT exam_period_label AS rok,
       exam_date,
       exam_time,
       string_agg(DISTINCT accreditation, '/' ORDER BY accreditation) AS akreditacije
FROM exams
WHERE academic_year = :'year'
  AND course_name_norm = 'matematika 1'
GROUP BY exam_period_label, exam_date, exam_time
ORDER BY exam_date;

-- 3. Fuzzy pogadanje sa greskom u kucanju. Vise razlicitih predmeta u rezultatu
--    znaci da je pitanje dvosmisleno i da bot treba da trazi pojasnjenje.
SELECT DISTINCT course_name,
       round(similarity(course_name_norm, 'matemtika 1')::numeric, 3) AS slicnost
FROM exams
WHERE academic_year = :'year'
  AND course_name_norm % 'matemtika 1'
ORDER BY slicnost DESC
LIMIT 5;

-- 4. Prvi naredni termin za predmet (podrazumevani odgovor kad rok nije naveden).
SELECT course_name, exam_period_label, exam_date, exam_time
FROM exams
WHERE academic_year = :'year'
  AND course_name_norm = 'fizika'
  AND exam_date >= CURRENT_DATE
ORDER BY exam_date
LIMIT 1;

-- 5. Slucajevi gde akreditacije 2013 i 2019 imaju razlicit termin.
--    Ocekivano: mali broj (11 grupa u 2025/2026). Samo tu se prikazuje akreditacija.
SELECT course_name, exam_period_label, count(DISTINCT (exam_date, exam_time)) AS termina
FROM exams
WHERE academic_year = :'year'
GROUP BY course_name, exam_period_label, study_level
HAVING count(DISTINCT (exam_date, exam_time)) > 1
ORDER BY course_name;

-- 6. Da li se koristi trigram indeks (ocekivano: Bitmap Index Scan on exams_course_trgm_idx).
EXPLAIN ANALYZE
SELECT count(*) FROM exams WHERE course_name_norm % 'matematika 1';
