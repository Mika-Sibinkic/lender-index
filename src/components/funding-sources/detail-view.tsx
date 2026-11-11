import type { FundingSourceRow } from '@/lib/types/funding-source'
import { EditableField } from './editable-field'
import { DeleteButton } from './delete-button'
import { LendingStatusControl } from './lending-status-control'
import { ASSET_CLASS_CHOICES, INTL_DOMESTIC_CHOICES, LENDER_TYPE_CHOICES, OPERATION_CHOICES, type Choice } from '@/lib/funding-sources/vocabularies'
import { ASSET_SUBTYPES } from '@/lib/config/domain'
import { USAGE_CODES } from '@/lib/funding-sources/usage-codes'

function Section({
  title,
  kicker,
  children,
}: {
  title?: string
  kicker?: string
  children: React.ReactNode
}) {
  return (
    <section className="border-t border-border/55 pt-6 first:border-t-0 first:pt-0">
      {kicker && (
        <div className="mb-3 text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
          {kicker}
        </div>
      )}
      {title && (
        <h2 className="mb-4 font-heading text-[20px] tracking-[-0.005em] text-foreground/95">
          {title}
        </h2>
      )}
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/90 mb-1.5">
      {children}
    </label>
  )
}

function Field({
  row,
  field,
  label,
  ...rest
}: {
  row: FundingSourceRow
  field: keyof FundingSourceRow
  label: string
  type?: 'text' | 'number' | 'currency' | 'textarea' | 'email' | 'array' | 'select' | 'multiselect'
  placeholder?: string
  monoOnDisplay?: boolean
  options?: ReadonlyArray<Choice>
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <EditableField
        id={row.id}
        field={field}
        value={row[field] as string | number | string[] | null}
        {...rest}
      />
    </div>
  )
}

export function DetailView({ row }: { row: FundingSourceRow }) {
  return (
    <article className="mx-auto max-w-3xl px-5 sm:px-8 py-8 sm:py-12 space-y-8">
      <header className="space-y-2 pb-2">
        {row.status !== 'active' && (
          <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            <span className="rounded-sm border border-border/70 bg-background/60 px-1.5 py-px text-[9px] text-muted-foreground">
              {row.status.replace('_', ' ')}
            </span>
          </div>
        )}
        <EditableField
          id={row.id}
          field="company_name"
          value={row.company_name}
          placeholder="Company name"
          className="font-heading text-[32px] leading-tight tracking-[-0.015em] text-foreground/95 sm:text-[40px]"
        />
        {row.primary_contact_name && (
          <div className="text-[14px] text-muted-foreground">
            {row.primary_contact_name}
            {row.primary_contact_title ? (
              <span className="text-muted-foreground/80">{' · '}{row.primary_contact_title}</span>
            ) : null}
          </div>
        )}
        {/* Top of the record, not buried in Lending parameters: this is the most
            perishable fact on the card, staff maintain it by hand from phone
            calls, and ranking depends on it. */}
        <div className="pt-2">
          <LendingStatusControl id={row.id} value={row.lending_status} />
        </div>
      </header>

      <Section kicker="Identity">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
          <Field row={row} field="lender_type" label="Type" type="select" options={LENDER_TYPE_CHOICES} />
        </div>
      </Section>

      <Section kicker="Primary contact">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
          <Field row={row} field="primary_contact_name" label="Name" placeholder="Name" />
          <Field row={row} field="primary_contact_title" label="Title" placeholder="Title" />
          <Field row={row} field="primary_contact_email" label="Email" type="email" placeholder="Email" />
          <Field row={row} field="primary_contact_phone" label="Phone" placeholder="Phone" />
        </div>
      </Section>

      <Section kicker="Lending parameters">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-4">
          <Field row={row} field="deal_size_min_usd" label="Loan min ($)" type="currency" monoOnDisplay />
          <Field row={row} field="deal_size_max_usd" label="Loan max ($)" type="currency" monoOnDisplay />
          <Field row={row} field="borrower_revenue_min_usd" label="Revenue min ($)" type="currency" monoOnDisplay />
          <Field row={row} field="borrower_years_in_business_min" label="Years min" type="number" monoOnDisplay />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
          <Field row={row} field="bank_paid_fee" label="Bank paid fee" placeholder="Y / N / %" />
        </div>
        <Field row={row} field="rate_notes" label="Rate notes" type="textarea" />
      </Section>

      <Section kicker="Asset & usage">
        <Field row={row} field="asset_subtypes" label="Asset subtypes" type="array" placeholder={ASSET_SUBTYPES.join(', ')} />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-3">
          <Field row={row} field="usage_codes" label="Usage" placeholder={USAGE_CODES.join(', ')} />
          <Field row={row} field="operation_category" label="Operation category" type="select" options={OPERATION_CHOICES} />
          <Field row={row} field="vintage_restriction" label="Vintage restriction" placeholder="e.g. 2000 or newer" />
        </div>
        {/*
          Asset class is a HARD-EXCLUDE dimension — assetDim can return
          `contradict`, so a value the matcher does not recognise silently drops
          the lender from every search naming an asset type. As free text that
          was one typo away ("construction equipment" vs "construction_equipment"),
          with no error anywhere to show it. A list plus an "other" box is
          more intuitive; it is also the difference between a guessable field and
          a guaranteed one.
        */}
        <Field
          row={row}
          field="asset_classes"
          label="Asset classes (drives search matching)"
          type="multiselect"
          options={ASSET_CLASS_CHOICES}
        />
      </Section>

      {/*
        Geographic Target should be US or International; Specific Geography
        should be states or countries. The two fields had drifted into one: "Geographic
        target" was the array holding US AND IL AND WI AND MO together, while the
        category lived under Identity as "International / Domestic". Target is now
        the category and Specific Geography is the place list, which is what a
        broker reading the card expects each line to mean.
      */}
      {/*
        Geography is TWO fields, not three.

        The card carried a third box, `specific_geographic` — the free-text cell
        the spreadsheet import copies verbatim. Operators asked what the
        difference between the three boxes was when they saw duplicated states.
        The answer is that there is no difference.

        Measured against a real roster: most rows hold the same list of places
        character-for-character, many hold the single word "All" (which states
        nothing), some are empty on both or have the list only, and the few that
        looked different only did so because the comparison stripped the "US"
        token — they already carry US in the list.

        Then the matcher was run over every lender twice, with the field and
        without, across a set of geographies, and ZERO verdicts changed.

        So it is off the card. The column stays in the database, in the report
        export and in lenderGeoCells — dropping it from matching would be a
        behaviour change to defend rather than a simplification, and it costs
        nothing to keep as a redundant read of what the visible list holds.
      */}
      <Section kicker="Geography">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
          <Field
            row={row}
            field="intl_domestic"
            label="Geographic target"
            type="select"
            options={INTL_DOMESTIC_CHOICES}
          />
          <Field row={row} field="geographic_scope" label="States / countries served" type="array" placeholder="TX, CA, Brazil, Canada…" />
        </div>
      </Section>

      <Section kicker="Internal notes">
        <EditableField
          id={row.id}
          field="internal_notes"
          value={row.internal_notes}
          type="textarea"
        />
      </Section>

      <footer className="flex items-center justify-end border-t border-border/55 pt-6">
        <DeleteButton id={row.id} companyName={row.company_name} />
      </footer>
    </article>
  )
}
