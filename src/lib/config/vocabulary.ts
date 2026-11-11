// Edit this file to fit your firm's asset classes. Stored ids must not change once data exists.
// After editing run `pnpm test`: src/lib/config/vocabulary.check.test.ts validates this file.
// The rest of the suite runs against the shipped defaults in src/test/default-vocabulary.ts.

import type { AssetAgeConfig, AssetCategory, OperationCategory, UsageCode } from '@/lib/config/domain'

export const ASSET_CATEGORIES: readonly AssetCategory[] = [
  {
    id: 'equipment',
    label: 'Equipment (any type)',
    icon: 'Cog',
    keywords: ['equipment', 'machinery', 'machine', 'machines', 'equipamento', 'maquinaria', 'equipo', 'équipement', 'equipement', 'maschine'],
  },
  {
    id: 'construction_equipment',
    label: 'Construction equipment',
    parent: 'equipment',
    icon: 'HardHat',
    keywords: ['construction equipment', 'excavator', 'bulldozer', 'backhoe', 'skid steer', 'wheel loader', 'crane', 'paver', 'escavadeira', 'excavadora', 'pelleteuse', 'bagger'],
    makes: ['caterpillar', 'komatsu', 'john deere', 'bobcat', 'hitachi', 'liebherr'],
    example: 'excavator',
  },
  {
    id: 'medical_equipment',
    label: 'Medical equipment',
    parent: 'equipment',
    icon: 'Stethoscope',
    // ' mri ' padded: a bare "mri" is too short to trust as a substring.
    keywords: ['medical equipment', ' mri ', 'ct scanner', 'x-ray', 'ultrasound', 'dental chair', 'equipamento medico', 'equipo medico'],
    makes: ['ge healthcare', 'siemens healthineers', 'philips'],
    example: 'MRI',
  },
  {
    id: 'agricultural_equipment',
    label: 'Agricultural equipment',
    parent: 'equipment',
    icon: 'Tractor',
    // ' tractor ' padded: a bare "tractor" fires inside "contractor" and "tractor-trailer".
    keywords: ['agricultural equipment', 'farm equipment', ' tractor ', ' tractors ', 'combine harvester', 'sprayer', ' trator ', ' tratores ', 'tractor agricola'],
    makes: ['kubota', 'new holland', 'claas', 'massey ferguson'],
    example: 'tractor',
  },
  {
    id: 'vehicles',
    label: 'Vehicles (any type)',
    icon: 'Car',
    keywords: ['vehicle', 'vehicles', 'fleet', ' car ', ' cars ', 'automobile', 'veiculo', 'veículo', 'vehiculo', 'vehículo', 'véhicule', 'fahrzeug'],
  },
  {
    id: 'commercial_trucks',
    label: 'Commercial trucks',
    parent: 'vehicles',
    icon: 'Truck',
    keywords: ['truck', 'trucks', 'semi truck', 'tractor-trailer', 'box truck', 'tow truck', 'dump truck', 'caminhao', 'caminhão', 'camion', 'lkw'],
    makes: ['freightliner', 'peterbilt', 'kenworth', 'mack', 'navistar'],
    example: 'box truck',
  },
  {
    id: 'real_estate',
    label: 'Real estate',
    icon: 'Building2',
    keywords: ['real estate', 'property', 'commercial property', 'warehouse', 'office building', 'imovel', 'imóvel', 'inmueble', 'immobilier', 'immobilie'],
  },
  {
    id: 'working_capital',
    label: 'Working capital',
    icon: 'Wallet',
    keywords: ['working capital', 'line of credit', 'receivables', 'invoice financing', 'inventory financing', 'capital de giro', 'capital de trabajo'],
  },
  { id: 'other', label: 'Other', icon: 'Waypoints', keywords: [] },
]

/** Readable (labels, glyphs) but never offered and never written. Empty = none. */
export const RETIRED_ASSET_CATEGORIES: readonly AssetCategory[] = []

/** Display pick-list for funding_sources.asset_subtypes. Never affects matching. */
export const ASSET_SUBTYPES: readonly string[] = ['New', 'Used', 'Refurbished']

/** How the financed asset is used. Rank-only dimension: boosts, never excludes. */
export const USAGE_CODES: readonly UsageCode[] = [
  { code: 'owner', label: 'Owner-operated', keywords: ['owner operated', 'owner-operated', 'owner user', 'owner-user', 'own use'] },
  { code: 'lease', label: 'Leased to a third party', keywords: ['leased out', 'lease out', 'third-party lease', 'third party lease', 'sublease'] },
  { code: 'rental', label: 'Rental fleet', keywords: ['rental fleet', 'rental', 'rent out'] },
]

/** Stored funding_sources.operation_category values. Rank-only dimension. */
export const OPERATION_CATEGORIES: readonly OperationCategory[] = [
  { value: 'Personal', label: 'Personal use', keywords: ['personal use', 'consumer'] },
  { value: 'Commercial', label: 'Commercial use', keywords: ['commercial use', 'business use', 'commercial'] },
  { value: 'Personal, Commercial', label: 'Both', keywords: [] },
]

export const BORROWER_INDUSTRIES: readonly string[] = [
  'construction', 'healthcare', 'logistics', 'manufacturing', 'agriculture',
  'retail', 'hospitality', 'transportation', 'energy', 'technology',
]

/** Used in every LLM prompt to say what kind of financing this index covers. */
export const DOMAIN_DESCRIPTION = 'equipment, vehicle, real estate and working capital financing'

/** Placeholder in the search box. Write it in your own asset vocabulary. */
export const DEMO_QUERY = 'Finance a used excavator around $8M for a borrower in Texas'

/**
 * Asset age / model-year facet. `bands` are the age buckets offered in the
 * search menu (`maxAge: null` = open-ended top band).
 */
export const ASSET_AGE: AssetAgeConfig = {
  oldestYear: 1960,
  label: 'Asset age',
  yearLabel: 'Asset model year',
  bands: [
    { label: '10-15 yr', minAge: 10, maxAge: 15 },
    { label: '15+ yr', minAge: 15, maxAge: null },
  ],
}
