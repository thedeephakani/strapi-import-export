import { isArraySafe, toArray } from '../../../libs/arrays.js';
import { ObjectBuilder, isObjectSafe } from '../../../libs/objects.js';
import { CustomSlugs } from '../../config/constants.js';
import { getModelAttributes, getModel } from '../../utils/models.js';
import { findOrImportFile, isExtensionAllowed } from './utils/file.js';
import { parseInputData } from './parsers.js';

/**
 * @typedef {Object} ImportDataRes
 * @property {Array<ImportDataFailures>} failures
 */
/**
 * Represents failed imports.
 * @typedef {Object} ImportDataFailures
 * @property {Error} error - Error raised.
 * @property {Object} data - Data for which import failed.
 */
/**
 * Import data.
 * @param {Array<Object>} dataRaw - Data to import.
 * @param {Object} options
 * @param {string} options.slug - Slug of the model to import.
 * @param {("csv" | "json")} options.format - Format of the imported data.
 * @param {Object} options.user - User importing the data.
 * @param {Object} options.idField - Field used as unique identifier.
 * @returns {Promise<ImportDataRes>}
 */
const importData = async (dataRaw, { slug, format, user, idField }) => {
  let data = await parseInputData(format, dataRaw, { slug });
  data = toArray(data);

  console.log('importDatas', slug, format, user, idField);
  let res;
  if (slug === CustomSlugs.MEDIA) {
    res = await importMedia(data, { user });
  } else {
    res = await importOtherSlug(data, { slug, user, idField });
  }

  return res;
};

const importMedia = async (fileData, { user }) => {
  const processed = [];
  for (let fileDatum of fileData) {
    let res;
    try {
      await findOrImportFile(fileDatum, user, { allowedFileTypes: ['any'] });
      res = { success: true };
    } catch (err) {
      strapi.log.error(err);
      res = { success: false, error: err.message, args: [fileDatum] };
    }
    processed.push(res);
  }

  const failures = processed.filter((p) => !p.success).map((f) => ({ error: f.error, data: f.args[0] }));

  return {
    failures,
  };
};

const importOtherSlug = async (data, { slug, user, idField }) => {
  const processed = [];
  for (let datum of data) {
    let res;
    try {
      await updateOrCreate(user, slug, datum, idField);
      res = { success: true };
    } catch (err) {
      strapi.log.error(err);
      res = { success: false, error: err.message, args: [datum] };
    }
    processed.push(res);
  }

  const failures = processed.filter((p) => !p.success).map((f) => ({ error: f.error, data: f.args[0] }));

  return {
    failures,
  };
};

/**
 * Update or create entries for a given model.
 * @param {Object} user - User importing the data.
 * @param {string} slug - Slug of the model.
 * @param {Object} data - Data to update/create entries from.
 * @param {string} idField - Field used as unique identifier.
 * @returns Updated/created entry.
 */
const updateOrCreate = async (user, slug, data, idField = 'id') => {
  const mediaRelations = [];
  const relationAttributes = getModelAttributes(slug, { filterType: ['component', 'dynamiczone', 'media', 'relation'] });
  for (let attribute of relationAttributes) {
    if (attribute.type === 'media') {
      if (Object.prototype.hasOwnProperty.call(data, attribute.name)) {
        mediaRelations.push({
          field: attribute.name,
          fileIds: await resolveMediaIds(data[attribute.name], attribute, user),
        });
        delete data[attribute.name];
      }
      continue;
    }

    data[attribute.name] = await updateOrCreateRelation(user, attribute, data[attribute.name]);
  }

  let entry;
  const model = getModel(slug);
  if (model.kind === 'singleType') {
    entry = await updateOrCreateSingleType(user, slug, data, idField);
  } else {
    entry = await updateOrCreateCollectionType(user, slug, data, idField);
  }

  if (entry?.id && mediaRelations.length) {
    await persistMediaRelations(slug, entry.id, mediaRelations);
  }

  return entry;
};

const resolveMediaIds = async (value, attribute, user) => {
  if (value == null || value === '') {
    return [];
  }

  let values = attribute.multiple && typeof value === 'string'
    ? value.split(';').map((item) => item.trim()).filter(Boolean)
    : toArray(value);
  if (!attribute.multiple) {
    values = values.slice(0, 1);
  }

  const fileIds = [];

  for (const mediaValue of values) {
    let file;
    const fileId = typeof mediaValue === 'number'
      ? mediaValue
      : isObjectSafe(mediaValue) && mediaValue.id != null
        ? Number(mediaValue.id)
        : typeof mediaValue === 'string' && /^\d+$/.test(mediaValue)
          ? Number(mediaValue)
          : null;

    if (fileId != null) {
      file = await strapi.db.query('plugin::upload.file').findOne({
        where: { id: fileId },
        select: ['id', 'name'],
      });
      if (file && !isExtensionAllowed(file.name.split('.').pop()?.toLowerCase() || '', attribute.allowedTypes ?? ['any'])) {
        file = null;
      }
    } else if (typeof mediaValue === 'string' && !/^https?:\/\//i.test(mediaValue)) {
      file = await findOrImportFile({ name: mediaValue }, user, { allowedFileTypes: attribute.allowedTypes ?? ['any'] });
    } else {
      file = await findOrImportFile(mediaValue, user, { allowedFileTypes: attribute.allowedTypes ?? ['any'] });
    }

    if (!file?.id) {
      const displayValue = typeof mediaValue === 'string' ? mediaValue : JSON.stringify(mediaValue);
      throw new Error(`Could not find an existing media file matching "${displayValue}" for field "${attribute.name}".`);
    }
    fileIds.push(file.id);
  }

  return fileIds;
};

const persistMediaRelations = async (relatedType, relatedId, relations) => {
  await strapi.db.connection.transaction(async (transaction) => {
    for (const { field, fileIds } of relations) {
      await transaction('files_related_mph')
        .where({ related_id: relatedId, related_type: relatedType, field })
        .delete();

      if (fileIds.length) {
        await transaction('files_related_mph').insert(
          fileIds.map((fileId, index) => ({
            file_id: fileId,
            related_id: relatedId,
            related_type: relatedType,
            field,
            order: index + 1,
          })),
        );
      }
    }
  });
};

const updateOrCreateCollectionType = async (user, slug, data, idField) => {
  const whereBuilder = new ObjectBuilder();
  if (data[idField] != null) {
    whereBuilder.extend({ [idField]: data[idField] });
  }
  const where = whereBuilder.get();

  const existingEntry = where[idField] ? await strapi.db.query(slug).findOne({ where }) : null;
  console.log('existingEntry1111:::::::::::::', existingEntry, slug, data, idField);
  // Prevent Strapi from throwing a unique constraint error on the id field.
  if (idField !== 'id') {
    delete data.id;
  }
  console.log('existingEntry22222:::::::::::::', existingEntry, slug, data, idField);
  if (existingEntry) {
    const updateData = { ...data };
    delete updateData.id;
    delete updateData.documentId;

    return strapi.documents(slug).update({
      documentId: existingEntry.documentId,
      data: updateData,
    });
  }

  return strapi.documents(slug).create({ data });
};

const updateOrCreateSingleType = async (user, slug, data, idField) => {
  delete data.id;

  const [existingEntry] = await strapi.db.query(slug).findMany();
  console.log('existingEntry3333:::::::::::::', existingEntry, slug, data, idField);
  if (existingEntry) {
    const updateData = { ...data };
    delete updateData.id;
    delete updateData.documentId;

    return strapi.documents(slug).update({
      documentId: existingEntry.documentId,
      data: updateData,
    });
  }

  return strapi.documents(slug).create({ data });
};

/**
 * Update or create a relation.
 * @param {Object} user
 * @param {Attribute} rel
 * @param {number | Object | Array<Object>} relData
 */
const updateOrCreateRelation = async (user, rel, relData) => {
  if (relData == null) {
    return null;
  }

  if (['createdBy', 'updatedBy'].includes(rel.name)) {
    return user.id;
  } else if (rel.type === 'dynamiczone') {
    const components = [];
    for (const componentDatum of relData || []) {
      let component = await updateOrCreate(user, componentDatum.__component, componentDatum);
      component = { ...component, __component: componentDatum.__component };
      components.push(component);
    }
    return components;
  } else if (rel.type === 'component') {
    relData = toArray(relData);
    relData = rel.repeatable ? relData : relData.slice(0, 1);
    const entryIds = [];
    for (const relDatum of relData) {
      if (typeof relDatum === 'number') {
        entryIds.push(relDatum);
      } else if (isObjectSafe(relDatum)) {
        const entry = await updateOrCreate(user, rel.component, relDatum);
        if (entry?.id) {
          entryIds.push(entry.id);
        }
      }
    }
    return rel.repeatable ? entryIds : entryIds?.[0] || null;
  } else if (rel.type === 'media') {
    relData = toArray(relData);
    relData = rel.multiple ? relData : relData.slice(0, 1);
    const entryIds = [];
    for (const relDatum of relData) {
      const media = await findOrImportFile(relDatum, user, { allowedFileTypes: rel.allowedTypes ?? ['any'] });
      if (media?.id) {
        entryIds.push(media.id);
      }
    }
    return rel.multiple ? entryIds : entryIds?.[0] || null;
  } else if (rel.type === 'relation') {
    const isMultipleRelation = rel.relation?.endsWith('ToMany');
    const isMultiple = isArraySafe(relData) || isMultipleRelation;
    if (isMultipleRelation && typeof relData === 'string') {
      relData = relData.split(';').map((value) => value.trim()).filter(Boolean);
    } else {
      relData = toArray(relData);
    }

    const entryIds = [];
    for (const relDatum of relData) {
      if (typeof relDatum === 'number') {
        const entryId = await findRelatedEntryById(rel.target, relDatum);
        entryIds.push(entryId);
      } else if (typeof relDatum === 'string') {
        const entryId = await findRelatedEntryId(rel.target, relDatum);
        entryIds.push(entryId);
      } else if (isObjectSafe(relDatum)) {
        const labelFields = Object.entries(relDatum).filter(
          ([name, value]) => /(?:name|title|label)$/i.test(name) && isCsvScalar(value),
        );
        const valueFields = labelFields.length
          ? labelFields
          : Object.entries(relDatum).filter(([name, value]) => !systemRelationFields.has(name) && isCsvScalar(value));
        const entryId = relDatum.id != null
          ? await findRelatedEntryById(rel.target, relDatum.id)
          : await findRelatedEntryId(rel.target, valueFields[0]?.[1], valueFields.map(([name]) => name));
        if (entryId == null) {
          throw new Error(`Could not find an existing ${rel.target} entry for the imported relation.`);
        }
        entryIds.push(entryId);
      }
    }
    return isMultiple ? entryIds : entryIds?.[0] || null;
  }

  throw new Error(`Could not update or create relation of type ${rel.type}.`);
};

const findRelatedEntryId = async (targetSlug, value, preferredAttributeNames = []) => {
  if (!isCsvScalar(value)) {
    return null;
  }

  const normalizedValue = String(value).trim();
  if (!normalizedValue) {
    return null;
  }

  const model = getModel(targetSlug);
  if (!model) {
    throw new Error(`Could not find related content type ${targetSlug}.`);
  }

  if (/^\d+$/.test(normalizedValue)) {
    const entryById = await findRelatedEntryById(targetSlug, Number(normalizedValue), false);
    if (entryById) {
      return entryById;
    }
  }

  const textAttributeTypes = new Set(['string', 'text', 'uid', 'email', 'enumeration']);
  const attributes = getModelAttributes(targetSlug).filter((attribute) => textAttributeTypes.has(attribute.type));
  const preferredAttributes = preferredAttributeNames
    .map((name) => attributes.find((attribute) => attribute.name === name))
    .filter(Boolean);
  const namedAttributes = attributes.filter(
    (attribute) => /(?:name|title|label)$/i.test(attribute.name) && !preferredAttributes.includes(attribute),
  );
  const fallbackAttributes = attributes.filter(
    (attribute) => !preferredAttributes.includes(attribute) && !namedAttributes.includes(attribute),
  );

  for (const attribute of [...preferredAttributes, ...namedAttributes, ...fallbackAttributes]) {
    const matches = await strapi.db.query(targetSlug).findMany({
      where: { [attribute.name]: normalizedValue },
      select: ['id'],
      orderBy: { id: 'asc' },
      limit: 2,
    });

    if (matches.length > 1) {
      strapi.log.warn(
        `Multiple ${targetSlug} entries match "${normalizedValue}" in "${attribute.name}"; using the entry with id ${matches[0].id}.`,
      );
    }
    if (matches.length > 0) {
      return matches[0].id;
    }
  }

  throw new Error(`Could not find a ${targetSlug} entry matching "${normalizedValue}".`);
};

const findRelatedEntryById = async (targetSlug, id, throwIfMissing = true) => {
  const entry = await strapi.db.query(targetSlug).findOne({
    where: { id },
    select: ['id'],
  });
  if (entry) {
    return entry.id;
  }
  if (throwIfMissing) {
    throw new Error(`Could not find an existing ${targetSlug} entry with id "${id}".`);
  }
  return null;
};

const systemRelationFields = new Set([
  'id',
  'documentId',
  'createdAt',
  'updatedAt',
  'publishedAt',
  'locale',
  'localizations',
]);

const isCsvScalar = (value) => ['string', 'number', 'boolean'].includes(typeof value);

export {
  importData,
};