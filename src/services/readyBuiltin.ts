// The Ready.gov guides Outpost knows about out of the box, used when no ready_gov_catalog.json exists.
// Every link was taken from a ready.gov page and checked to answer with a PDF on 2026-11-01.

const F = 'https://www.ready.gov/sites/default/files/';

type Raw = { id: string; title: string; description: string; tags: string[]; file: string; download: string };
const g = (id: string, title: string, description: string, tags: string[], at: string, file = at.split('/').pop()!): Raw => ({
  id,
  title,
  description,
  tags,
  file,
  download: F + at,
});

const hazard = (id: string, name: string, extra: string[] = []): Raw =>
  g(id, `${name} information sheet`, `What to do before, during and after: ${name.toLowerCase()}.`, ['hazard', ...extra], `2024-03/ready.gov_${id}_hazard-info-sheet.pdf`);

export const BUILTIN_READY_CATALOG = {
  categories: [
    {
      name: 'Action plans',
      items: [
        g('are-you-ready', 'Are You Ready? An in-depth guide to citizen preparedness', 'The full FEMA guide: plans, supplies and every major hazard in one book.', ['guide', 'plan'], '2021-11/are-you-ready-guide.pdf'),
        g('supply-kit', 'Emergency supply kit checklist', 'The basic disaster supplies kit as a printable checklist.', ['kit', 'checklist'], '2024-05/ready_supply-kit-checklist.pdf'),
        g('family-plan-card', 'Family communication plan (fillable card)', 'Wallet cards for contacts and meeting places.', ['plan', 'family', 'contacts'], '2025-06/family-communication-plan_fillable-card.pdf'),
        g('commuter-plan', 'Commuter emergency plan', 'Plan for getting home or sheltering when a disaster hits during the commute.', ['plan', 'travel'], '2020-03/commuter_emergency_plan.pdf'),
        g('12-ways', '12 ways to prepare', 'A postcard of quick, low-cost preparedness steps.', ['plan', 'quick'], '2020-11/ready_12-ways-to-prepare_postcard.pdf'),
        g('alerts', 'Know your alerts and warnings', 'The alert systems that can reach you and how to sign up.', ['alerts', 'warnings'], '2020-03/ready_know-your-alerts-and-warnings.pdf'),
        g('alerts-guide', 'Guide for alerts and warnings', 'A longer FEMA guide to emergency alerts.', ['alerts', 'warnings'], '2022-02/fema_guide-for-alerts-and-warnings_2021.pdf.pdf', 'fema_guide-for-alerts-and-warnings_2021.pdf'),
        g('safeguard-documents', 'Safeguard critical documents and valuables', 'Which papers to protect and how to store copies.', ['documents', 'money'], '2020-03/fema_safeguard-critical-documents-and-valuables.pdf'),
        g('insure-property', 'Document and insure your property', 'Record what you own and check your insurance before a disaster.', ['insurance', 'money'], '2020-03/ready_document-and-insure-your-property.pdf'),
        g('financial-toolkit', 'Emergency financial first aid kit', 'Gather the financial, medical and legal records you would need.', ['money', 'documents'], '2020-03/ready_emergency-financial-first-aid-toolkit.pdf'),
        g('financial-sheet', 'Financial preparedness information sheet', 'Short steps to prepare your finances for an emergency.', ['money'], '2021-01/ready_financial-emergency_info-sheet.pdf'),
      ],
    },
    {
      name: 'Hazard information sheets',
      items: [
        g('all-hazards', 'All hazard information sheets (full set)', 'Every hazard sheet in one file.', ['hazard'], '2025-02/fema_full-suite-hazard-info-sheets.pdf'),
        hazard('active-shooter', 'Active shooter', ['violence']),
        hazard('avalanche', 'Avalanche', ['snow']),
        hazard('cyberattack', 'Cyberattack', ['online']),
        hazard('earthquake', 'Earthquake'),
        hazard('extreme-heat', 'Extreme heat', ['heat']),
        hazard('flood', 'Flood', ['water']),
        hazard('hurricane', 'Hurricane', ['storm', 'wind']),
        hazard('landslide', 'Landslide'),
        hazard('novel-pandemic', 'Pandemic', ['illness']),
        hazard('power-outage', 'Power outage', ['electricity']),
        hazard('thunderstorm', 'Thunderstorm and lightning', ['storm']),
        hazard('tornado', 'Tornado', ['storm', 'wind']),
        hazard('tsunami', 'Tsunami', ['water']),
        hazard('volcano', 'Volcano'),
        hazard('wildfire', 'Wildfire', ['fire', 'smoke']),
        hazard('winter-storm', 'Winter storm', ['snow', 'cold']),
      ],
    },
    {
      name: 'Specialized guides',
      items: [
        g('older-adults-guide', 'Disaster preparedness guide for older adults', 'Step-by-step planning for older adults and those who help them.', ['older adults', 'plan'], '2023-09/ready-gov_disaster-preparedness-guide-for-older-adults.pdf'),
        g('older-adults-flyer', 'Older adults flyer', 'A one-page summary for older adults.', ['older adults'], '2023-09/ready.gov_older-adults_flyer.pdf'),
        g('older-adults-es', 'Older adults and people with disabilities (Spanish)', 'Guía en español para adultos mayores y personas con discapacidades.', ['older adults', 'disabilities', 'spanish'], '2023-09/ready-gov_older-adults_disabilities_spanish.pdf'),
        g('seniors', 'Prepare now: seniors', 'A short checklist for seniors.', ['older adults'], '2020-03/ready_prepare-now-seniors.pdf'),
        g('caregivers', 'Caregivers preparedness guide', 'Planning for people who care for someone else.', ['caregivers', 'plan'], '2024-02/ready-gov_caregivers-preparedness-guide.pdf'),
        g('disabilities', 'Preparing makes sense for people with disabilities', 'Planning for people with disabilities and access and functional needs.', ['disabilities', 'access'], '2026-09/ready-gov_rsl_preparing-makes-sense-for-people-with-disabilities.pdf'),
        g('disabilities-2021', 'Preparing makes sense (2021 edition)', 'The earlier edition of the disabilities guide.', ['disabilities'], '2021-05/ready_preparing-makes-sense.pdf'),
        g('disabilities-es', 'Preparing makes sense (Spanish)', 'La guía en español.', ['disabilities', 'spanish'], '2025-06/preparing-makes-sense_spanish.pdf'),
        g('disabilities-bookmark', 'Disabilities bookmark', 'A printable bookmark with key steps.', ['disabilities'], '2023-05/ready.gov_disabilities_bookmark_front-back.pdf'),
        g('disabilities-2014-es', 'Disabilities and special needs (Spanish, 2014)', 'Guía en español, 2014.', ['disabilities', 'spanish'], '2020-08/2014_disabilites_es.pdf'),
        g('disabilities-2014-es-print', 'Disabilities and special needs (Spanish, printer friendly)', 'Versión para imprimir.', ['disabilities', 'spanish'], '2020-08/2014_PrinterFriendly_DisabilitiesSpecialNeeds_ES.pdf'),
        g('pets', 'Prepare your pets for disasters', 'Supplies and plans for pets and other animals.', ['pets', 'animals'], '2023-06/ready.gov_prepare-pets-for-disasters.pdf'),
        g('pets-es', 'Prepare your pets for disasters (Spanish)', 'Prepare a sus mascotas para desastres.', ['pets', 'animals', 'spanish'], '2023-06/ready.gov_prepare-pets-for-disasters_spanish.pdf'),
        g('pet-owners', 'Pet owners fact sheet', 'A printer-friendly fact sheet for pet owners.', ['pets', 'animals'], '2020-04/pet-owners-fact-sheet_printer-friendly.pdf'),
      ],
    },
    {
      name: 'Business',
      items: [
        g('risk-assessment', 'Business risk assessment table', 'Rate the hazards your business faces.', ['business', 'workplace'], '2020-04/business_risk-assessment-table.pdf'),
        g('program-coordinator', 'Program coordinator and committee worksheet', 'Who runs your business preparedness program.', ['business', 'workplace'], '2020-04/program-coordinator-committee-worksheet.pdf'),
        g('business-insurance', 'Business insurance discussion form', 'Questions to go over with your insurance agent.', ['business', 'insurance'], '2020-07/business-insurance-discussion-form.pdf'),
      ],
    },
  ],
};
