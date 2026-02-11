-- ============================================================================
-- 002_seed_data.sql
-- Seed data for dev project: test org, test route, SA university variants
-- ============================================================================

-- Test organization
INSERT INTO organizations (id, name, slug, description, owner_id, vertical)
VALUES (
    '00000000-0000-4000-8000-000000000001',
    'SA-Recruitment',
    'sa-recruitment',
    'South African teacher recruitment agency',
    '00000000-0000-4000-8000-000000000099',
    'recruitment'
) ON CONFLICT (id) DO NOTHING;

-- Test inbound email route
INSERT INTO inbound_email_routes (id, source_email, user_id, organization_id, inbox_tz_id)
VALUES (
    '00000000-0000-4000-8000-000000000002',
    'recruitment@sa-recruitment.com',
    '00000000-0000-4000-8000-000000000099',
    '00000000-0000-4000-8000-000000000001',
    'Africa/Johannesburg'
) ON CONFLICT (id) DO NOTHING;

-- SA University Variants (comprehensive list of all 26 public universities)
INSERT INTO sa_university_variants (canonical_university, variant, norm_variant) VALUES
-- University of Cape Town
('University of Cape Town', 'University of Cape Town', 'university of cape town'),
('University of Cape Town', 'UCT', 'uct'),
('University of Cape Town', 'U.C.T.', 'u c t'),
('University of Cape Town', 'Cape Town University', 'cape town university'),
-- University of the Witwatersrand
('University of the Witwatersrand', 'University of the Witwatersrand', 'university of the witwatersrand'),
('University of the Witwatersrand', 'Wits', 'wits'),
('University of the Witwatersrand', 'Wits University', 'wits university'),
('University of the Witwatersrand', 'WITS', 'wits'),
-- University of Pretoria
('University of Pretoria', 'University of Pretoria', 'university of pretoria'),
('University of Pretoria', 'UP', 'up'),
('University of Pretoria', 'Tuks', 'tuks'),
('University of Pretoria', 'U.P.', 'u p'),
-- Stellenbosch University
('Stellenbosch University', 'Stellenbosch University', 'stellenbosch university'),
('Stellenbosch University', 'University of Stellenbosch', 'university of stellenbosch'),
('Stellenbosch University', 'US', 'us'),
('Stellenbosch University', 'Maties', 'maties'),
('Stellenbosch University', 'SU', 'su'),
-- University of KwaZulu-Natal
('University of KwaZulu-Natal', 'University of KwaZulu-Natal', 'university of kwazulu natal'),
('University of KwaZulu-Natal', 'UKZN', 'ukzn'),
('University of KwaZulu-Natal', 'KwaZulu-Natal University', 'kwazulu natal university'),
('University of KwaZulu-Natal', 'University of Natal', 'university of natal'),
-- University of Johannesburg
('University of Johannesburg', 'University of Johannesburg', 'university of johannesburg'),
('University of Johannesburg', 'UJ', 'uj'),
('University of Johannesburg', 'Rand Afrikaans University', 'rand afrikaans university'),
('University of Johannesburg', 'RAU', 'rau'),
-- University of the Free State
('University of the Free State', 'University of the Free State', 'university of the free state'),
('University of the Free State', 'UFS', 'ufs'),
('University of the Free State', 'UOVS', 'uovs'),
('University of the Free State', 'Kovsies', 'kovsies'),
-- North-West University
('North-West University', 'North-West University', 'north west university'),
('North-West University', 'NWU', 'nwu'),
('North-West University', 'Potchefstroom University', 'potchefstroom university'),
('North-West University', 'PU for CHE', 'pu for che'),
('North-West University', 'Potch', 'potch'),
-- University of South Africa
('University of South Africa', 'University of South Africa', 'university of south africa'),
('University of South Africa', 'UNISA', 'unisa'),
('University of South Africa', 'Unisa', 'unisa'),
-- Rhodes University
('Rhodes University', 'Rhodes University', 'rhodes university'),
('Rhodes University', 'Rhodes', 'rhodes'),
('Rhodes University', 'RU', 'ru'),
-- Nelson Mandela University
('Nelson Mandela University', 'Nelson Mandela University', 'nelson mandela university'),
('Nelson Mandela University', 'NMU', 'nmu'),
('Nelson Mandela University', 'Nelson Mandela Metropolitan University', 'nelson mandela metropolitan university'),
('Nelson Mandela University', 'NMMU', 'nmmu'),
('Nelson Mandela University', 'University of Port Elizabeth', 'university of port elizabeth'),
('Nelson Mandela University', 'UPE', 'upe'),
-- University of the Western Cape
('University of the Western Cape', 'University of the Western Cape', 'university of the western cape'),
('University of the Western Cape', 'UWC', 'uwc'),
-- University of Limpopo
('University of Limpopo', 'University of Limpopo', 'university of limpopo'),
('University of Limpopo', 'UL', 'ul'),
('University of Limpopo', 'University of the North', 'university of the north'),
-- University of Venda
('University of Venda', 'University of Venda', 'university of venda'),
('University of Venda', 'UNIVEN', 'univen'),
-- Tshwane University of Technology
('Tshwane University of Technology', 'Tshwane University of Technology', 'tshwane university of technology'),
('Tshwane University of Technology', 'TUT', 'tut'),
-- Cape Peninsula University of Technology
('Cape Peninsula University of Technology', 'Cape Peninsula University of Technology', 'cape peninsula university of technology'),
('Cape Peninsula University of Technology', 'CPUT', 'cput'),
-- Durban University of Technology
('Durban University of Technology', 'Durban University of Technology', 'durban university of technology'),
('Durban University of Technology', 'DUT', 'dut'),
-- Central University of Technology
('Central University of Technology', 'Central University of Technology', 'central university of technology'),
('Central University of Technology', 'CUT', 'cut'),
-- Vaal University of Technology
('Vaal University of Technology', 'Vaal University of Technology', 'vaal university of technology'),
('Vaal University of Technology', 'VUT', 'vut'),
-- Mangosuthu University of Technology
('Mangosuthu University of Technology', 'Mangosuthu University of Technology', 'mangosuthu university of technology'),
('Mangosuthu University of Technology', 'MUT', 'mut'),
-- Walter Sisulu University
('Walter Sisulu University', 'Walter Sisulu University', 'walter sisulu university'),
('Walter Sisulu University', 'WSU', 'wsu'),
-- University of Zululand
('University of Zululand', 'University of Zululand', 'university of zululand'),
('University of Zululand', 'UniZulu', 'unizulu'),
('University of Zululand', 'UNIZULU', 'unizulu'),
-- University of Fort Hare
('University of Fort Hare', 'University of Fort Hare', 'university of fort hare'),
('University of Fort Hare', 'UFH', 'ufh'),
-- University of Mpumalanga
('University of Mpumalanga', 'University of Mpumalanga', 'university of mpumalanga'),
('University of Mpumalanga', 'UMP', 'ump'),
-- Sol Plaatje University
('Sol Plaatje University', 'Sol Plaatje University', 'sol plaatje university'),
('Sol Plaatje University', 'SPU', 'spu'),
-- Sefako Makgatho Health Sciences University
('Sefako Makgatho Health Sciences University', 'Sefako Makgatho Health Sciences University', 'sefako makgatho health sciences university'),
('Sefako Makgatho Health Sciences University', 'SMU', 'smu'),
('Sefako Makgatho Health Sciences University', 'MEDUNSA', 'medunsa')
ON CONFLICT DO NOTHING;
