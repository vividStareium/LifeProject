const habitTemplateFields = [
  'id',
  'user_id',
  'group_id',
  'source_key',
  'source_name',
  'source_type',
  'title',
  'description',
  'question',
  'frequency_kind',
  'frequency_rule',
  'unit',
  'target_type',
  'target_value',
  'color',
  'sort_order',
  'start_date',
  'archived_at',
  'created_at',
  'updated_at'
];

export const habitTemplateSelectFields = habitTemplateFields.join(',');

export const habitTemplateSelectFieldsWithoutGroup = habitTemplateFields
  .filter((field) => field !== 'group_id')
  .join(',');

export const habitTemplateSelectFieldsLegacy = habitTemplateFields
  .filter((field) => field !== 'group_id' && field !== 'start_date')
  .join(',');

export const habitDailyRecordSelectFields = [
  'id',
  'user_id',
  'template_id',
  'record_date',
  'value_text',
  'value_number',
  'completion_state',
  'notes',
  'source_type',
  'source_key',
  'raw_payload',
  'created_at',
  'updated_at'
].join(',');

export const isSchemaError = (message: string) => {
  const lower = message.toLowerCase();
  return (
    lower.includes('schema cache') ||
    lower.includes('does not exist') ||
    lower.includes('column') ||
    lower.includes('relation')
  );
};
