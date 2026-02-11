-- ============================================================================
-- 000_existing_schema.sql
-- Recreates the existing production schema in the dev project.
-- These tables already exist in production — this is a one-time setup
-- for the development/staging project only.
-- ============================================================================

-- ============================================================================
-- 1. organizations
-- ============================================================================
CREATE TABLE IF NOT EXISTS organizations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    slug        text NOT NULL,
    description text,
    owner_id    uuid NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    vertical    text DEFAULT 'general'::text
);

-- ============================================================================
-- 2. inbound_email_routes
-- ============================================================================
CREATE TABLE IF NOT EXISTS inbound_email_routes (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_email    text NOT NULL,
    user_id         uuid NOT NULL,
    organization_id uuid NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    inbox_tz_id     text NOT NULL DEFAULT 'Africa/Johannesburg'::text,
    tz_locked       boolean NOT NULL DEFAULT true
);

-- ============================================================================
-- 3. candidates
-- ============================================================================
CREATE TABLE IF NOT EXISTS candidates (
    id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                         uuid NOT NULL,
    organization_id                 uuid NOT NULL,
    source_email                    text NOT NULL,
    canonical_day                   date NOT NULL,
    date_received                   timestamptz NOT NULL DEFAULT now(),
    candidate_name                  text,
    email_address                   text,
    contact_number                  text,
    educational_qualifications_raw  text,
    degree_institution_raw          text,
    degree_country_raw              text,
    has_education_degree            boolean DEFAULT false,
    qualification_type              text DEFAULT 'Unknown'::text,
    years_teaching_experience       numeric DEFAULT 0,
    teaching_phase_specialisation   text DEFAULT 'Unknown'::text,
    teaching_phase_alignment        text DEFAULT 'unknown'::text,
    has_tefl                        boolean DEFAULT false,
    has_tesol                       boolean DEFAULT false,
    has_celta                       boolean DEFAULT false,
    countries_raw                   text[] DEFAULT '{}'::text[],
    current_location_raw            text,
    raw_ai_score                    integer DEFAULT 0,
    ai_notes                        text,
    degree_institution_norm         text,
    created_at                      timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- 4. sa_university_variants
-- ============================================================================
CREATE TABLE IF NOT EXISTS sa_university_variants (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_university    text NOT NULL,
    variant                 text NOT NULL,
    norm_variant            text NOT NULL
);

-- Index for fast lookups during qualification gate
CREATE INDEX IF NOT EXISTS idx_sa_uni_norm_variant
    ON sa_university_variants (norm_variant);

CREATE INDEX IF NOT EXISTS idx_sa_uni_canonical
    ON sa_university_variants (canonical_university);

-- ============================================================================
-- 5. candidate_scored view
-- Computes scoring columns used by the dashboard.
-- Scoring logic based on business-rules.md:
--   sa_university_match: institution found in sa_university_variants
--   score_sa_uni:        20 points if matched
--   score_qualification: 30 for BEd/PGCE/HDE, 20 for BA/BSc/BCom Ed, 10 for Other, 0 for Unknown
--   score_experience:    min(30, years * 6) — caps at 30 points
--   score_extras:        5 per TEFL/TESOL/CELTA (max 10)
--   final_score:         sum of above
--   band:                A (70+), B (50-69), C (30-49), D (<30)
-- ============================================================================
CREATE OR REPLACE VIEW candidate_scored AS
SELECT
    c.*,
    -- SA university match
    EXISTS (
        SELECT 1 FROM sa_university_variants suv
        WHERE c.degree_institution_norm IS NOT NULL
        AND suv.norm_variant = c.degree_institution_norm
    ) AS sa_university_match,

    -- Score: SA university (20 points)
    CASE
        WHEN EXISTS (
            SELECT 1 FROM sa_university_variants suv
            WHERE c.degree_institution_norm IS NOT NULL
            AND suv.norm_variant = c.degree_institution_norm
        ) THEN 20
        ELSE 0
    END AS score_sa_uni,

    -- Score: Qualification type (up to 30 points)
    CASE
        WHEN c.qualification_type IN ('BEd', 'PGCE', 'HDE') THEN 30
        WHEN c.qualification_type IN ('BA_Education', 'BSc_Education', 'BCom_Education') THEN 20
        WHEN c.qualification_type = 'Other' THEN 10
        ELSE 0
    END AS score_qualification,

    -- Score: Experience (up to 30 points, 6 per year capped at 30)
    LEAST(30, (COALESCE(c.years_teaching_experience, 0) * 6)::integer) AS score_experience,

    -- Score: Extras — TEFL/TESOL/CELTA (5 each, max 10)
    LEAST(10,
        (CASE WHEN c.has_tefl THEN 5 ELSE 0 END) +
        (CASE WHEN c.has_tesol THEN 5 ELSE 0 END) +
        (CASE WHEN c.has_celta THEN 5 ELSE 0 END)
    ) AS score_extras,

    -- Final score (sum of all)
    (
        CASE
            WHEN EXISTS (
                SELECT 1 FROM sa_university_variants suv
                WHERE c.degree_institution_norm IS NOT NULL
                AND suv.norm_variant = c.degree_institution_norm
            ) THEN 20
            ELSE 0
        END
        +
        CASE
            WHEN c.qualification_type IN ('BEd', 'PGCE', 'HDE') THEN 30
            WHEN c.qualification_type IN ('BA_Education', 'BSc_Education', 'BCom_Education') THEN 20
            WHEN c.qualification_type = 'Other' THEN 10
            ELSE 0
        END
        +
        LEAST(30, (COALESCE(c.years_teaching_experience, 0) * 6)::integer)
        +
        LEAST(10,
            (CASE WHEN c.has_tefl THEN 5 ELSE 0 END) +
            (CASE WHEN c.has_tesol THEN 5 ELSE 0 END) +
            (CASE WHEN c.has_celta THEN 5 ELSE 0 END)
        )
    ) AS final_score,

    -- Band classification
    CASE
        WHEN (
            CASE
                WHEN EXISTS (
                    SELECT 1 FROM sa_university_variants suv
                    WHERE c.degree_institution_norm IS NOT NULL
                    AND suv.norm_variant = c.degree_institution_norm
                ) THEN 20 ELSE 0
            END
            +
            CASE
                WHEN c.qualification_type IN ('BEd', 'PGCE', 'HDE') THEN 30
                WHEN c.qualification_type IN ('BA_Education', 'BSc_Education', 'BCom_Education') THEN 20
                WHEN c.qualification_type = 'Other' THEN 10
                ELSE 0
            END
            +
            LEAST(30, (COALESCE(c.years_teaching_experience, 0) * 6)::integer)
            +
            LEAST(10,
                (CASE WHEN c.has_tefl THEN 5 ELSE 0 END) +
                (CASE WHEN c.has_tesol THEN 5 ELSE 0 END) +
                (CASE WHEN c.has_celta THEN 5 ELSE 0 END)
            )
        ) >= 70 THEN 'A'
        WHEN (
            CASE
                WHEN EXISTS (
                    SELECT 1 FROM sa_university_variants suv
                    WHERE c.degree_institution_norm IS NOT NULL
                    AND suv.norm_variant = c.degree_institution_norm
                ) THEN 20 ELSE 0
            END
            +
            CASE
                WHEN c.qualification_type IN ('BEd', 'PGCE', 'HDE') THEN 30
                WHEN c.qualification_type IN ('BA_Education', 'BSc_Education', 'BCom_Education') THEN 20
                WHEN c.qualification_type = 'Other' THEN 10
                ELSE 0
            END
            +
            LEAST(30, (COALESCE(c.years_teaching_experience, 0) * 6)::integer)
            +
            LEAST(10,
                (CASE WHEN c.has_tefl THEN 5 ELSE 0 END) +
                (CASE WHEN c.has_tesol THEN 5 ELSE 0 END) +
                (CASE WHEN c.has_celta THEN 5 ELSE 0 END)
            )
        ) >= 50 THEN 'B'
        WHEN (
            CASE
                WHEN EXISTS (
                    SELECT 1 FROM sa_university_variants suv
                    WHERE c.degree_institution_norm IS NOT NULL
                    AND suv.norm_variant = c.degree_institution_norm
                ) THEN 20 ELSE 0
            END
            +
            CASE
                WHEN c.qualification_type IN ('BEd', 'PGCE', 'HDE') THEN 30
                WHEN c.qualification_type IN ('BA_Education', 'BSc_Education', 'BCom_Education') THEN 20
                WHEN c.qualification_type = 'Other' THEN 10
                ELSE 0
            END
            +
            LEAST(30, (COALESCE(c.years_teaching_experience, 0) * 6)::integer)
            +
            LEAST(10,
                (CASE WHEN c.has_tefl THEN 5 ELSE 0 END) +
                (CASE WHEN c.has_tesol THEN 5 ELSE 0 END) +
                (CASE WHEN c.has_celta THEN 5 ELSE 0 END)
            )
        ) >= 30 THEN 'C'
        ELSE 'D'
    END AS band

FROM candidates c;
