

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;


CREATE TABLE source_files (
  path        TEXT PRIMARY KEY,
  sha256      TEXT        NOT NULL,
  record_count INT        NOT NULL DEFAULT 0,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- textual data

CREATE TABLE documents (
  id            BIGSERIAL PRIMARY KEY,
  source_url    TEXT        NOT NULL UNIQUE,
  category      TEXT        NOT NULL,          
  academic_year TEXT,
  published_at  DATE,
  title         TEXT        NOT NULL,
  title_norm    TEXT        NOT NULL,          
  summary       TEXT,
  filters       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  raw           JSONB       NOT NULL,
  content_hash  TEXT        NOT NULL,
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX documents_category_year_idx ON documents (category, academic_year);
CREATE INDEX documents_published_at_idx  ON documents (published_at DESC NULLS LAST);
CREATE INDEX documents_filters_idx       ON documents USING gin (filters jsonb_path_ops);

CREATE TABLE chunks (
  id          BIGSERIAL PRIMARY KEY,
  document_id BIGINT      NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  ord         INT         NOT NULL,
  heading     TEXT        NOT NULL DEFAULT '',
  text        TEXT        NOT NULL,           
  text_norm   TEXT        NOT NULL,            
  token_count INT         NOT NULL DEFAULT 0,
  filters     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  embedding   VECTOR(1536),
  UNIQUE (document_id, ord)
);

ALTER TABLE chunks
  ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(text_norm, ''))) STORED;

CREATE INDEX chunks_tsv_idx     ON chunks USING gin (tsv);
CREATE INDEX chunks_trgm_idx    ON chunks USING gin (text_norm gin_trgm_ops);
CREATE INDEX chunks_filters_idx ON chunks USING gin (filters jsonb_path_ops);
CREATE INDEX chunks_document_idx ON chunks (document_id);


CREATE INDEX chunks_embedding_idx ON chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);




CREATE TABLE exams (
  id             BIGSERIAL PRIMARY KEY,
  academic_year  TEXT NOT NULL,
  rok            TEXT NOT NULL,       
  rok_label      TEXT,
  pdf_url        TEXT,
  study_level    TEXT NOT NULL,        
  accreditation  TEXT,
  semester       TEXT,
  module         TEXT,
  course_code    TEXT,
  course_name    TEXT NOT NULL,
  course_name_norm TEXT NOT NULL,      
  exam_date      DATE,
  exam_time      TIME
);

CREATE INDEX exams_lookup_idx      ON exams (academic_year, study_level, semester, module);
CREATE INDEX exams_rok_idx         ON exams (rok);
CREATE INDEX exams_code_idx        ON exams (course_code);
CREATE INDEX exams_date_idx        ON exams (exam_date);
CREATE INDEX exams_course_trgm_idx ON exams USING gin (course_name_norm gin_trgm_ops);


CREATE TABLE schedules (
  id             BIGSERIAL PRIMARY KEY,
  file           TEXT NOT NULL UNIQUE,     
  academic_year  TEXT NOT NULL,
  study_level    TEXT NOT NULL,
  semester       INT,
  study_year     INT,
  semester_type  TEXT,                   
  module         TEXT,
  submodule      TEXT,
  module_label   TEXT,
  page_url       TEXT,
  pdf_url        TEXT,
  pdf_sha256     TEXT,
  group_rooms    JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw            JSONB NOT NULL
);

CREATE INDEX schedules_lookup_idx ON schedules
  (academic_year, study_level, semester, module, submodule);

CREATE TABLE schedule_entries (
  id             BIGSERIAL PRIMARY KEY,
  schedule_id    BIGINT NOT NULL REFERENCES schedules (id) ON DELETE CASCADE,
  day            TEXT NOT NULL
                 CHECK (day IN ('ponedeljak','utorak','sreda','cetvrtak','petak','subota')),
  starts_at      TIME,
  ends_at        TIME,
  class_type     TEXT,                     
  course         TEXT NOT NULL,
  course_norm    TEXT NOT NULL,
  groups         TEXT[] NOT NULL DEFAULT '{}',
  room           TEXT,
  rooms_by_group JSONB NOT NULL DEFAULT '{}'::jsonb,
  from_ocr       BOOLEAN NOT NULL DEFAULT false,
  ocr_confidence INT,
  raw_text       TEXT
);

CREATE INDEX schedule_entries_schedule_idx ON schedule_entries (schedule_id, day, starts_at);
CREATE INDEX schedule_entries_course_trgm_idx ON schedule_entries USING gin (course_norm gin_trgm_ops);


CREATE TABLE index_groups (
  id             BIGSERIAL PRIMARY KEY,
  academic_year  TEXT NOT NULL,
  source_url     TEXT,
  index_from     INT NOT NULL,
  index_to       INT NOT NULL,
  lecture_group  TEXT,
  exercise_group TEXT,
  UNIQUE (academic_year, index_from, index_to)
);

CREATE INDEX index_groups_range_idx ON index_groups (academic_year, index_from, index_to);


CREATE TABLE calendar_levels (
  id             BIGSERIAL PRIMARY KEY,
  academic_year  TEXT NOT NULL,
  study_level    TEXT NOT NULL,
  label          TEXT,
  source_url     TEXT,
  pdf_url        TEXT,
  semesters      JSONB NOT NULL DEFAULT '{}'::jsonb,   
  raspust        JSONB,
  overa_semestra TEXT,
  raw            JSONB NOT NULL,
  UNIQUE (academic_year, study_level)
);

CREATE TABLE calendar_exam_periods (
  id           BIGSERIAL PRIMARY KEY,
  level_id     BIGINT NOT NULL REFERENCES calendar_levels (id) ON DELETE CASCADE,
  naziv        TEXT NOT NULL,        
  labela       TEXT,
  held_from    DATE,
  held_to      DATE,
  held_raw     TEXT,
  apply_from   DATE,                   
  apply_to     DATE,                  
  apply_raw    TEXT,
  UNIQUE (level_id, naziv)
);

CREATE INDEX calendar_exam_periods_dates_idx ON calendar_exam_periods (held_from, held_to);

CREATE TABLE calendar_days (
  id        BIGSERIAL PRIMARY KEY,
  level_id  BIGINT NOT NULL REFERENCES calendar_levels (id) ON DELETE CASCADE,
  kind      TEXT NOT NULL CHECK (kind IN ('radni', 'neradni')),
  day       DATE NOT NULL,
  note      TEXT,
  raw       TEXT
);

CREATE INDEX calendar_days_day_idx ON calendar_days (day);
