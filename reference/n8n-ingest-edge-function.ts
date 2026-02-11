import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface CandidatePayload {
  user_id?: string;
  organization_id?: string;
  source_email: string;
  canonical_day: string; // "YYYY-MM-DD"
  date_received?: string; // ISO timestamp
  
  candidate_name: string;
  email_address?: string;
  contact_number?: string;
  
  educational_qualifications_raw?: string;
  degree_institution_raw?: string;
  degree_country_raw?: string;
  
  has_education_degree: boolean;
  qualification_type: string;
  
  years_teaching_experience: number;
  teaching_phase_specialisation?: string;
  teaching_phase_alignment: string;
  
  has_tefl: boolean;
  has_tesol: boolean;
  has_celta: boolean;
  
  countries_raw?: string[];
  current_location_raw?: string;
  
  raw_ai_score: number;
  ai_notes?: string;
}

interface RequestPayload {
  candidates: CandidatePayload[];
  stats?: {
    total_incoming_items: number;
    total_candidates: number;
    generated_at: string;
  };
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const payload: RequestPayload = await req.json();
    console.log(`Processing ${payload.candidates?.length || 0} candidates`);

    const results = [];
    const errors = [];
    const skipped = [];

    for (const candidate of payload.candidates || []) {
      try {
        // Resolve user_id and organization_id if not provided
        let userId = candidate.user_id;
        let orgId = candidate.organization_id;

        if (!userId || !orgId) {
          const { data: route } = await supabase
            .from('inbound_email_routes')
            .select('user_id, organization_id')
            .eq('source_email', candidate.source_email)
            .single();

          if (route) {
            userId = userId || route.user_id;
            orgId = orgId || route.organization_id;
          }
        }

        if (!userId || !orgId) {
          errors.push({
            candidate: candidate.candidate_name,
            error: 'Could not resolve user_id or organization_id'
          });
          continue;
        }

        // ============ DEDUPLICATION CHECK (24 hours) ============
        const now = new Date();
        const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        
        // Build deduplication query: match by email OR name within same org and last 24h
        let dupeQuery = supabase
          .from('candidates')
          .select('id, candidate_name, email_address, created_at')
          .eq('organization_id', orgId)
          .gte('created_at', twentyFourHoursAgo.toISOString());

        // If candidate has email, check by email; otherwise check by name
        if (candidate.email_address && candidate.email_address.trim()) {
          dupeQuery = dupeQuery.ilike('email_address', candidate.email_address.trim());
        } else {
          dupeQuery = dupeQuery.ilike('candidate_name', candidate.candidate_name.trim());
        }

        const { data: existingDupes } = await dupeQuery.limit(1);

        if (existingDupes && existingDupes.length > 0) {
          const existing = existingDupes[0];
          console.log(`⊘ Duplicate skipped: ${candidate.candidate_name} (matches existing ID: ${existing.id})`);
          skipped.push({
            candidate: candidate.candidate_name,
            email: candidate.email_address,
            reason: 'Duplicate within 24 hours',
            existing_id: existing.id,
            existing_created_at: existing.created_at
          });
          continue; // Skip insertion
        }

        // Normalize degree institution
        const degreeNorm = candidate.degree_institution_raw
          ? candidate.degree_institution_raw
              .toLowerCase()
              .replace(/[^a-zA-Z0-9]+/g, ' ')
              .trim()
          : null;

        // ============ FIX: Derive canonical_day from date_received in SA timezone ============
        // This ensures candidates appear on the correct date based on when the email was received,
        // not when it was processed by n8n
        const dateReceivedStr = candidate.date_received || new Date().toISOString();
        const dateReceived = new Date(dateReceivedStr);
        
        // Convert to SA timezone (Africa/Johannesburg) and extract YYYY-MM-DD
        // Using Intl.DateTimeFormat for reliable timezone conversion
        const saFormatter = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Africa/Johannesburg',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        });
        const derivedCanonicalDay = saFormatter.format(dateReceived); // Returns YYYY-MM-DD format
        
        console.log(`📅 Date derivation: received_utc=${dateReceivedStr}, sa_canonical_day=${derivedCanonicalDay} (payload had: ${candidate.canonical_day})`);

        // Insert into candidates table
        const { data: inserted, error: insertError } = await supabase
          .from('candidates')
          .insert({
            user_id: userId,
            organization_id: orgId,
            source_email: candidate.source_email,
            canonical_day: derivedCanonicalDay, // Use derived date, not payload
            date_received: dateReceivedStr,
            
            candidate_name: candidate.candidate_name,
            email_address: candidate.email_address,
            contact_number: candidate.contact_number,
            
            educational_qualifications_raw: candidate.educational_qualifications_raw,
            degree_institution_raw: candidate.degree_institution_raw,
            degree_country_raw: candidate.degree_country_raw,
            degree_institution_norm: degreeNorm,
            
            has_education_degree: candidate.has_education_degree,
            qualification_type: candidate.qualification_type,
            
            years_teaching_experience: candidate.years_teaching_experience,
            teaching_phase_specialisation: candidate.teaching_phase_specialisation,
            teaching_phase_alignment: candidate.teaching_phase_alignment,
            
            has_tefl: candidate.has_tefl,
            has_tesol: candidate.has_tesol,
            has_celta: candidate.has_celta,
            
            countries_raw: candidate.countries_raw,
            current_location_raw: candidate.current_location_raw,
            
            raw_ai_score: candidate.raw_ai_score,
            ai_notes: candidate.ai_notes,
          })
          .select()
          .single();

        if (insertError) {
          console.error('Insert error:', insertError);
          errors.push({
            candidate: candidate.candidate_name,
            error: insertError.message
          });
        } else {
          console.log(`✓ Inserted: ${candidate.candidate_name}`);
          results.push({
            candidate: candidate.candidate_name,
            id: inserted.id,
            status: 'inserted'
          });
        }
      } catch (err) {
        console.error('Processing error:', err);
        errors.push({
          candidate: candidate.candidate_name,
          error: err.message
        });
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        inserted: results.length,
        duplicates_skipped: skipped.length,
        errors: errors.length,
        results,
        skipped: skipped.length > 0 ? skipped : undefined,
        errors: errors.length > 0 ? errors : undefined,
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      }
    );

  } catch (error) {
    console.error('Request error:', error);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error.message 
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500 
      }
    );
  }
});
