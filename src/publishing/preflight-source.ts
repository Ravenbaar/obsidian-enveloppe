import { Notice, parseYaml, type TFile } from 'obsidian';
import type { Properties, Repository } from '@interfaces';
import type Enveloppe from 'src/main';
import { getReceiptFolder } from 'src/conversion/file_path';
import { inspectPublicationSource, isPublishingArticle, PublicationPreflightError } from './preflight';

export async function checkPublicationSource(plugin: Enveloppe, file: TFile, repository: Repository | null,
  properties?: Properties | Properties[], destination?: string) {
  const path = destination ?? getReceiptFolder(file, repository, plugin, properties);
  if (!isPublishingArticle(plugin.settings.publishing?.enabled, path)) return;
  const source = await plugin.app.vault.read(file);
  try { return { source, protection: inspectPublicationSource(source, parseYaml, path) }; }
  catch (error) {
    if (error instanceof PublicationPreflightError) throw error.withFilename(file.name);
    throw error;
  }
}

const reportedErrors = new WeakSet<PublicationPreflightError>();

export function showPublicationPreflightError(plugin: Enveloppe, error: unknown, filename?: string): boolean {
  if (!(error instanceof PublicationPreflightError)) return false;
  if (reportedErrors.has(error)) return true;
  if (filename) error.withFilename(filename);
  reportedErrors.add(error);
  const detail = error.message;
  plugin.publicationCenter?.failPreflight(detail);
  new Notice(detail, 12000);
  return true;
}

export async function checkPublicationBatch(plugin: Enveloppe, files: TFile[], repository: Repository | null,
  properties: Properties | Properties[]): Promise<boolean> {
  try {
    for (const file of files) await checkPublicationSource(plugin, file, repository, properties);
    return true;
  } catch (error) {
    if (showPublicationPreflightError(plugin, error)) return false;
    throw error;
  }
}
