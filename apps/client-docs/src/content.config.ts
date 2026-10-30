import {defineCollection} from 'astro:content';
import {glob} from 'astro/loaders';
import {i18nLoader} from '@astrojs/starlight/loaders';
import {docsSchema,i18nSchema} from '@astrojs/starlight/schema';

// README files explain repository maintenance and are deliberately not public pages.
export const collections={docs:defineCollection({
  loader:glob({
    base:'./src/content/docs',pattern:['**/[^_]*.{md,mdx}','!**/README.md'],
    // Keep the final index until Starlight maps it once; api/index/index.md is the main module.
    generateId:({entry})=>entry.replace(/\.(md|mdx)$/,'').toLowerCase(),
  }),
  schema:docsSchema(),
}),i18n:defineCollection({loader:i18nLoader(),schema:i18nSchema()})};
