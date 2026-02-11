# Business Rules — SA-Recruitment CV Screening

## Client
Nicole at SA-Recruitment. Recruits South African teachers for positions in the UAE and other international markets.

## What Nicole Receives
Emails to a dedicated inbox from teachers applying for positions. Each email typically has:
- 1-3 attachments (CV, sometimes a cover letter, sometimes certificates)
- The CV is the target document — everything else is supplementary

## Candidate Requirements (HARD GATES — reject if not met)

### 1. Must Have an Education Degree
The candidate must hold a **degree** (not diploma, not certificate) in education from a **registered South African tertiary institution**.

**Qualifying degrees:**
- BEd (Bachelor of Education)
- BA Education / BA with PGCE
- BSc Education / BSc with PGCE  
- BCom Education / BCom with PGCE
- Any bachelor's degree + PGCE (Postgraduate Certificate in Education)
- HDE (Higher Diploma in Education) — legacy qualification, counts as degree-equivalent

**NOT qualifying:**
- Diploma in Education (alone)
- Certificate in Education (alone)
- TEFL/TESOL/CELTA (alone — these are add-ons, not primary qualifications)
- Currently studying / student
- Foreign degrees (unless also SA-qualified)

### 2. Must Have South Africa Connection
At least ONE of:
- `countries_raw` includes "South Africa" / "SA" / "RSA"
- `degree_country_raw` is South Africa
- `current_location_raw` indicates South Africa
- Degree institution is a known SA university

### 3. Degree From Registered SA Institution
The degree-granting institution must appear in the `sa_university_variants` table.

This table contains canonical university names and their common variants/abbreviations. Examples:
- "University of Cape Town" / "UCT"
- "University of the Witwatersrand" / "Wits" / "WITS University"
- "University of Pretoria" / "UP" / "Tuks"
- "North-West University" / "NWU" / "Potchefstroom"

**Soft gate:** If the institution doesn't match any variant, flag it in the audit log but don't hard-reject — the variant list may be incomplete and we should add new variants as we discover them.

### 4. No Fabricated Candidates
Block any candidate whose name matches known AI hallucination patterns:
- John Smith, Jane Doe, John Doe, Jane Smith
- Sarah Johnson (known DeepSeek hallucination)
- Test Candidate, Sample Candidate, Example Candidate
- Any name that appears to be a placeholder

## Soft Signals (LOG but don't reject)

### Experience
- `years_teaching_experience < 1` — flag as "may be student or new graduate"
- `years_teaching_experience < 2` — flag as "limited experience"
- Nicole may still want to see these candidates

### TEFL/TESOL/CELTA
- Bonus qualifications — note their presence but they don't qualify alone
- `has_tefl`, `has_tesol`, `has_celta` fields

### Teaching Phase
- `teaching_phase_specialisation`: Foundation (Gr R-3), Intermediate (Gr 4-6), Senior (early high school), FET (upper high school)
- `teaching_phase_alignment`: Whether their qualification matches the phase they teach
- Both are informational — captured for Nicole's filtering, not gating criteria

## Candidate Data Fields

These map to the `candidates` table columns:

| Field | Description | Example |
|---|---|---|
| candidate_name | Full name, no titles | "Anje van Niekerk" |
| email_address | From the CV or email header | "anje@gmail.com" |
| contact_number | Phone number | "+27 82 123 4567" |
| educational_qualifications_raw | All qualifications verbatim | "BEd (Foundation Phase), University of Pretoria, 2018" |
| degree_institution_raw | University of teaching degree | "University of Pretoria" |
| degree_country_raw | Country of that university | "South Africa" |
| has_education_degree | Boolean: has a qualifying degree | true |
| qualification_type | One of: BEd, BA_Education, BSc_Education, BCom_Education, PGCE, Other, Unknown | "BEd" |
| years_teaching_experience | Total years teaching | 5.0 |
| teaching_phase_specialisation | Foundation / Intermediate / Senior / FET / Unknown | "Foundation" |
| teaching_phase_alignment | aligned / partial / not_aligned / unknown | "aligned" |
| has_tefl | Boolean | false |
| has_tesol | Boolean | false |
| has_celta | Boolean | false |
| countries_raw | Array of countries linked to candidate | ["South Africa", "UAE"] |
| current_location_raw | Current location | "Cape Town, South Africa" |
| raw_ai_score | 0-100 holistic score | 78 |
| ai_notes | 1-3 sentence score explanation | "Qualified BEd, 5 years experience, aligned phase" |

## Scoring (handled by `candidate_scored` view — DO NOT REBUILD)

The existing `candidate_scored` PostgreSQL view computes:
- `sa_university_match` — does institution match `sa_university_variants`?
- `score_sa_uni` — points for SA university match
- `score_qualification` — points for degree type
- `score_experience` — points for years of experience
- `score_extras` — points for TEFL/TESOL/CELTA
- `final_score` — weighted total
- `band` — A/B/C/D classification

The dashboard reads this view. We don't touch it. Our job is to insert clean, accurate rows into `candidates` and let the view do its scoring.
