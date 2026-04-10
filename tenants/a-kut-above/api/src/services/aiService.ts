import { claude, openai } from '../config/ai';
import { env } from '../config/env';

export const aiService = {
  async generateCaption(photoType: string, serviceType: string, notes?: string): Promise<string> {
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Write a short, casual social media caption for a ${photoType} photo of a ${serviceType.replace(/_/g, ' ')} job done by A Kut Above Tree Service, a family-owned tree service in South Mississippi. ${notes ? `Context: ${notes}` : ''} Keep it under 2 sentences, friendly and authentic. No hashtags.`,
      }],
    });
    return response.content[0].type === 'text' ? response.content[0].text : '';
  },

  async generateSocialPost(serviceType: string, beforeUrl?: string, afterUrl?: string, notes?: string, variation?: boolean): Promise<string> {
    const variationHint = variation
      ? '\n- IMPORTANT: Write this in a DIFFERENT style than a previous version. Try a different opening, different structure, and different call to action. Be creative with the angle.'
      : '';

    const response = await claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Write a Facebook/Instagram post for A Kut Above Tree Service (family-owned, South Mississippi).
Job type: ${serviceType.replace(/_/g, ' ')}
${notes ? `Details: ${notes}` : ''}
${beforeUrl && afterUrl ? 'This post includes before & after photos.' : ''}

Requirements:
- Professional but warm tone. Write like a small business owner, not a teenager.
- Do NOT use slang, hype words, or phrases like "big shoutout", "let's go", "crushed it", etc.
- No emojis
- Short (2-3 sentences max)
- End with a soft call to action (e.g. "Give us a call for a free estimate")
- Include 2-3 relevant hashtags at the end
- If no job details/notes are provided, keep the post general about the type of service. Do not make up specific details about the job.
- Include the phone number: (228) 297-4366${variationHint}`,
      }],
    });
    return response.content[0].type === 'text' ? response.content[0].text : '';
  },

  async generateOutreachEmail(contactType: string, stage: number, contactName: string, companyName?: string): Promise<{ subject: string; body: string }> {
    const stagesByType: Record<string, Record<number, string>> = {
      realtor: {
        1: 'Introduction - family-owned tree service, we help your listings look better and close faster. Mention $100 referral bonus per closed job.',
        2: 'Social proof - 5-star rated, over 30 years experience. Trees that need removal or trimming can delay closings. We respond fast.',
        3: 'Value add - share tips: what to look for during home inspections (dead trees, leaning trees, root damage), how tree issues affect property value and appraisals.',
        4: 'Referral program details - $100 per closed job referral. Simple process: just send us the homeowner\'s name and number. We handle the rest.',
        5: 'Case example - describe helping a realtor\'s client with a tree issue that was holding up a closing. Quick turnaround, everyone happy.',
        6: 'Friendly check-in - just touching base, here if you ever need us for a client. No pressure.',
      },
      insurance_agent: {
        1: 'Introduction - family-owned tree service that handles storm damage and emergency tree removal. Licensed and insured. Fast response times.',
        2: 'Social proof - 5-star rated, 30+ years experience. We work with insurance companies regularly and can provide detailed documentation and photos.',
        3: 'Value add - share tips on tree hazards that could lead to claims (dead limbs over roofs, hollow trunks, root damage to foundations). Preventive trimming saves claims.',
        4: 'Partnership offer - we can be a preferred vendor for your clients. We provide before/after photos, detailed invoices, and work directly with adjusters.',
        5: 'Case example - describe handling storm damage cleanup for an insured homeowner. Fast response, thorough documentation, smooth claims process.',
        6: 'Friendly check-in - hurricane season reminder, here if any of your policyholders need tree work. No pressure.',
      },
      landscaper: {
        1: 'Introduction - family-owned tree service. We handle the big stuff (removals, large trimming, stump grinding) so you can focus on what you do best.',
        2: 'Social proof - 5-star rated, 30+ years experience. We\'ve partnered with landscapers across the Gulf Coast. We don\'t compete with you — we complement your services.',
        3: 'Value add - when your clients need a tree removed or a stump ground before you can start your project, we can get it done quickly so you stay on schedule.',
        4: 'Referral partnership - we refer landscaping work to partners we trust, and we appreciate the same. Let\'s set up a simple referral arrangement that benefits both of us.',
        5: 'Case example - describe a project where a landscaper needed a tree removed and stumps ground before they could start a landscape renovation. We came in, knocked it out, and they started on time.',
        6: 'Friendly check-in - just touching base. If you have any upcoming projects that need tree work first, give us a call. We\'ll work around your schedule.',
      },
      contractor: {
        1: 'Introduction - family-owned tree service. We handle land clearing, tree removal, and stump grinding for construction and renovation projects.',
        2: 'Social proof - 5-star rated, 30+ years experience. We\'ve cleared lots for home builders, commercial developers, and general contractors across the Gulf Coast.',
        3: 'Value add - we can clear lots quickly so your project stays on timeline. We handle permits coordination, debris hauling, and can work around your subcontractor schedule.',
        4: 'Partnership offer - looking for a reliable tree service to call when you need lot clearing or tree removal on job sites. We show up on time and get it done right.',
        5: 'Case example - describe clearing a lot for a new home build. Removed 15+ trees, ground stumps, hauled debris. Contractor broke ground on schedule.',
        6: 'Friendly check-in - any projects coming up that need site clearing? We\'re booking out but can make room for partners we work with regularly.',
      },
    };

    const defaultStages: Record<number, string> = {
      1: 'Introduction - family-owned tree service, local trust, professional service.',
      2: 'Social proof - 5-star rated, 30+ years experience.',
      3: 'Value - share tips relevant to their industry.',
      4: 'Partnership offer - referral arrangement that benefits both sides.',
      5: 'Case example - describe a recent job scenario.',
      6: 'Friendly check-in - casual, no hard sell.',
    };

    const stages = stagesByType[contactType] || defaultStages;
    const stageDescription = stages[stage] || stages[1];

    const response = await claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Write a referral outreach email from A Kut Above Tree Service to a ${contactType.replace(/_/g, ' ')}.

Recipient: ${contactName}${companyName ? ` at ${companyName}` : ''}
Stage ${stage}/6: ${stageDescription}

Business context:
- Family-owned tree service in South Mississippi (Gautier, Moss Point, Ocean Springs, Biloxi, Pascagoula area)
- 5-star rated tree service, 30+ years experience
- Services: tree removal, trimming, stump grinding, land clearing, storm cleanup, emergency removal
- Phone: (228) 297-4366

Requirements:
- Sound human, not corporate
- No emojis
- Short (under 150 words for body)
- Professional but warm, not hip or young sounding
- Do not use slang or hype phrases
- Tailor the message specifically to a ${contactType.replace(/_/g, ' ')} — speak to their world and what matters to them
- Include a clear next step

Return as JSON: {"subject": "...", "body": "..."}`,
      }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '{}';
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : { subject: 'Introduction from A Kut Above', body: text };
    } catch {
      return { subject: 'Introduction from A Kut Above Tree Service', body: text };
    }
  },

  async generateAdCopy(serviceType: string, city: string): Promise<{ headline: string; description: string }> {
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Write a Google Ads copy for A Kut Above Tree Service targeting "${serviceType.replace(/_/g, ' ')}" in ${city}, MS.
Return as JSON: {"headline": "...(max 30 chars)", "description": "...(max 90 chars)"}
Make it urgent, local, and trustworthy.`,
      }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '{}';
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : { headline: 'A Kut Above Tree Service', description: 'Professional tree service in South Mississippi.' };
    } catch {
      return { headline: 'A Kut Above Tree Service', description: 'Professional tree service in South Mississippi.' };
    }
  },
};
