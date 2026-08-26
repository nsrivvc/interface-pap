// NatGasHub (NGH) — the API this project was built against.
//
// One file per upstream API. Everything that is true of NGH and only NGH
// lives here: what its feeds are called, which GitHub workflow ingests and
// transforms each one, and which physical tables each stage lands in.
// Nothing outside this file should mention "NGH", "gtran", or a bronze/silver
// table name — see providers/index.js for the shape and how to add another.
//
// Note: this app never calls the NGH HTTP API itself. The fetching lives in
// the ingestion subproject of the pipeline repo below; what we record here is
// the name of each source pipeline so the UI can label it.
export default {
  key: 'natgashub',
  label: 'NatGasHub',
  description: 'NGH gTran, gExchange and Index-of-Customers API pipelines',

  // The repo holding every transformation workflow (stages 1-5) for this API,
  // and the branch to run them on. Env vars still win — see providers/index.js.
  repo: { slug: 'nsrivvc/STAGE_3_4_5', ref: 'main' },

  // Tables that consolidate every feed at the end of Stage 5. Not owned by any
  // single feed, so they hang off the provider.
  finalTables: {
    core: { table: 'silver.final_core_master_capacity', orderBy: 'final_core_id' },
    locations: { table: 'silver.final_locations_master_capacity', orderBy: 'final_locations_id' },
    rates: { table: 'silver.final_rates_master_capacity', orderBy: 'final_rates_id' },
  },

  // Feed order here is the order the UI lists them in.
  feeds: {
    firm: {
      label: 'Firm',
      shortLabel: 'Firm',
      sourcePipeline: 'NGH-gTran-Firms-API-Pipeline',
      workflows: { pipeline: 'firm(stage3_4_5).yml', ingest: 'bronze_ingest_firm.yml' },
      tables: {
        bronze: { table: 'bronze.gtran_firm', orderBy: 'bronze_row_id' },
        // Stage 3 phases: one table each, in the order they run
        silverPhases: {
          deduplicated: { table: 'silver_staging.firm_deduplicated' },
          amended: { table: 'silver_staging.firm_amended' },
          decomposed: { table: 'silver_staging.firm_decomposed' },
        },
        silverStaging: {
          locations: { table: 'silver_staging.firm_locations', orderBy: '"index"' },
          core: { table: 'silver_staging.firm_core', orderBy: 'bronze_row_id' },
          rates: { table: 'silver_staging.firm_rates', orderBy: 'bronze_row_id' },
        },
        recDel: { table: 'silver.firm_rec_del_pair', orderBy: 'rec_del_pair_id' },
        masterCapacity: {
          core: { table: 'silver.firm_core_master_capacity', orderBy: 'firm_core_id' },
          locations: { table: 'silver.firm_locations_master_capacity', orderBy: 'firm_locations_id' },
          rates: { table: 'silver.firm_rates_master_capacity', orderBy: 'firm_rates_id' },
        },
      },
    },

    interruptible: {
      label: 'Interruptible',
      shortLabel: 'IT',
      sourcePipeline: 'NGH-gTran-Interruptibles-API-Pipeline',
      workflows: {
        pipeline: 'interruptible(stage3_4_5).yml',
        ingest: 'bronze_ingest_interruptibles.yml',
      },
      tables: {
        bronze: { table: 'bronze.gtran_it', orderBy: 'bronze_row_id' },
        silverPhases: {
          deduplicated: { table: 'silver_staging.interruptible_deduplicated' },
          amended: { table: 'silver_staging.interruptible_amended' },
          decomposed: { table: 'silver_staging.interruptible_decomposed' },
        },
        silverStaging: {
          locations: { table: 'silver_staging.interruptible_locations' },
          core: { table: 'silver_staging.interruptible_core' },
          rates: { table: 'silver_staging.interruptible_rates' },
        },
        recDel: { table: 'silver.interruptible_rec_del_pair' },
        masterCapacity: {
          core: { table: 'silver.interruptible_core_master_capacity' },
          locations: { table: 'silver.interruptible_locations_master_capacity' },
          rates: { table: 'silver.interruptible_rates_master_capacity' },
        },
      },
    },

    awards: {
      label: 'Awards',
      shortLabel: 'Awards',
      sourcePipeline: 'NGH-gExchange-Awards-API-Pipeline',
      workflows: { pipeline: 'awards(stage3_4_5).yml', ingest: 'bronze_ingest_awards.yml' },
      tables: {
        bronze: { table: 'bronze.gawd', orderBy: 'bronze_row_id' },
        silverStaging: {
          locations: { table: 'silver_staging.awards_locations' },
          core: { table: 'silver_staging.awards_core' },
          rates: { table: 'silver_staging.awards_rates' },
        },
        recDel: { table: 'silver.awards_rec_del_pair' },
        masterCapacity: {
          core: { table: 'silver.awards_core_master_capacity' },
          locations: { table: 'silver.awards_locations_master_capacity' },
          rates: { table: 'silver.awards_rates_master_capacity' },
        },
      },
    },

    // Index of Customers has no Stage 3-5 logic, so its end-to-end workflow is
    // the ingest itself and every downstream table map is null.
    index: {
      label: 'Index of Customers',
      shortLabel: 'IOC',
      sourcePipeline: 'NGH-IndexOfCustomers-API-Pipeline',
      workflows: { pipeline: 'bronze_ingest_ioc.yml', ingest: 'bronze_ingest_ioc.yml' },
      tables: {
        bronze: { table: 'bronze.gindex', orderBy: 'bronze_row_id' },
        silverStaging: null,
        recDel: null,
        masterCapacity: null,
      },
    },
  },
};
