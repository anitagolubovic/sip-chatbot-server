-- Satnica ispita: trajanje i sale, objavljuju se pred sam rok.

ALTER TABLE exams
  ADD COLUMN duration_minutes INT,
  ADD COLUMN rooms            TEXT,
  ADD COLUMN slot_url         TEXT;
