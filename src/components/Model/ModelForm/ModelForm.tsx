import {
  ActionIcon,
  Button,
  Container,
  Text,
  Grid,
  Group,
  Paper,
  Stack,
  Title,
  Alert,
  ThemeIcon,
  Divider,
} from '@mantine/core';
import { CommercialUse, Model, ModelStatus, ModelType, TagTarget } from '@prisma/client';
import { openConfirmModal } from '@mantine/modals';
import {
  IconAlertTriangle,
  IconArrowDown,
  IconArrowLeft,
  IconArrowUp,
  IconCurrencyDollarOff,
  IconExclamationMark,
  IconInfoCircle,
  IconBrush,
  IconPhoto,
  IconPlus,
  IconShoppingCart,
  IconTrash,
} from '@tabler/icons';
import { TRPCClientErrorBase } from '@trpc/client';
import { DefaultErrorShape } from '@trpc/server';
import { useRouter } from 'next/router';
import React, { useEffect, useMemo, useState } from 'react';
import { useFieldArray } from 'react-hook-form';
import { z } from 'zod';

import { FileList } from '~/components/Model/ModelForm/FileList';
import {
  Form,
  InputCheckbox,
  InputImageUpload,
  InputMultiSelect,
  InputNumber,
  InputRTE,
  InputSegmentedControl,
  InputSelect,
  InputSwitch,
  InputText,
  useForm,
} from '~/libs/form';
import { modelSchema } from '~/server/schema/model.schema';
import { ModelFileInput, modelFileSchema } from '~/server/schema/model-file.schema';
import { modelVersionUpsertSchema } from '~/server/schema/model-version.schema';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { ModelById } from '~/types/router';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { slugit, splitUppercase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import { BaseModel, constants, ModelFileType } from '~/server/common/constants';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { v4 as uuidv4 } from 'uuid';
import { useCatchNavigation } from '~/hooks/useCatchNavigation';

/**NOTES**
  - If a model depicts an actual person, it cannot have nsfw content
  - If all of a models images are nsfw, then the model will be marked as nsfw
*/

const schema = modelSchema.extend({
  tagsOnModels: z.string().array(),
  modelVersions: z
    .array(
      modelVersionUpsertSchema
        .extend({
          uuid: z.string(),
          files: z.preprocess((val) => {
            const list = val as ModelFileInput[];
            return list.filter((file) => file.url);
          }, z.array(modelFileSchema)),
          skipTrainedWords: z.boolean().default(false),
        })
        .refine((data) => (!data.skipTrainedWords ? data.trainedWords.length > 0 : true), {
          message: 'You need to specify at least one trained word',
          path: ['trainedWords'],
        })
    )
    .min(1, 'At least one model version is required.'),
});
type FormSchema = z.infer<typeof schema>;

type CreateModelProps = z.infer<typeof modelSchema>;
type UpdateModelProps = Omit<CreateModelProps, 'id'> & { id: number };

type Props = { model?: ModelById };

export function ModelForm({ model }: Props) {
  const router = useRouter();
  const queryUtils = trpc.useContext();
  const editing = !!model;

  const { data: { items: tags } = { items: [] } } = trpc.tag.getAll.useQuery(
    { limit: 0, entityType: TagTarget.Model },
    { cacheTime: Infinity, staleTime: Infinity }
  );
  const addMutation = trpc.model.add.useMutation();
  const updateMutation = trpc.model.update.useMutation();
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [complete, setComplete] = useState<Record<string, boolean>>({});
  const [blocked, setBlocked] = useState<Record<string, boolean>>({});
  const isBlocked = Object.values(blocked).some((bool) => bool);
  const isComplete = Object.values(complete).every((bool) => bool);
  const isUploading = Object.values(uploading).some((bool) => bool);

  const defaultModelFile = {
    name: '',
    url: '',
    sizeKB: 0,
    type: constants.modelFileTypes[0] as ModelFileType,
  };

  const defaultModelVersion: FormSchema['modelVersions'][number] = {
    name: '',
    uuid: uuidv4(),
    description: null,
    epochs: null,
    steps: null,
    trainedWords: [],
    skipTrainedWords: false,
    baseModel: 'SD 1.5',
    images: [],
    files: [defaultModelFile],
  };

  const defaultValues: FormSchema = {
    ...model,
    name: model?.name ?? '',
    allowCommercialUse: model?.allowCommercialUse ?? CommercialUse.Sell,
    allowDerivatives: model?.allowDerivatives ?? true,
    allowNoCredit: model?.allowNoCredit ?? true,
    allowDifferentLicense: model?.allowDifferentLicense ?? true,
    type: model?.type ?? ModelType.Checkpoint,
    status: model?.status ?? ModelStatus.Published,
    tagsOnModels: model?.tagsOnModels.map(({ tag }) => tag.name) ?? [],
    modelVersions: model?.modelVersions.map(
      ({ trainedWords, images, files, baseModel, ...version }) => ({
        ...version,
        uuid: uuidv4(),
        baseModel: (baseModel as BaseModel) ?? defaultModelVersion.baseModel,
        trainedWords: trainedWords,
        skipTrainedWords: !trainedWords.length,
        // HOTFIX: Casting image.meta type issue with generated prisma schema
        images: images.map((image) => ({ ...image, meta: image.meta as ImageMetaProps })) ?? [],
        // HOTFIX: Casting files to defaultModelFile[] to avoid type confusion and accept room for error
        files: files.length > 0 ? (files as typeof defaultModelFile[]) : [defaultModelFile],
      })
    ) ?? [defaultModelVersion],
  };

  const form = useForm({
    schema,
    shouldUnregister: false,
    mode: 'onChange',
    defaultValues,
  });
  const { fields, prepend, remove, swap } = useFieldArray({
    control: form.control,
    name: 'modelVersions',
    rules: { minLength: 1, required: true },
  });

  const { isDirty, isSubmitted } = form.formState;
  useCatchNavigation({ unsavedChanges: isDirty && !isSubmitted });

  const tagsOnModels = form.watch('tagsOnModels');

  // #region [poiNsfw]
  function getIsNsfwPoi({
    poi,
    nsfw,
    images,
  }: {
    poi?: boolean;
    nsfw?: boolean;
    images?: { nsfw?: boolean }[];
  }) {
    const hasNsfwImages = images?.some((image) => image?.nsfw);
    return poi && (nsfw || hasNsfwImages);
  }

  const [nsfwPoi, setNsfwPoi] = useState(
    getIsNsfwPoi({ ...defaultValues, images: defaultValues.modelVersions.flatMap((v) => v.images) })
  );
  useEffect(() => {
    const subscription = form.watch((value, { name, type }) => {
      const match = name?.match(/modelVersions\.[0-9]\.images/);
      if (name === 'poi' || name === 'nsfw' || match || name === undefined) {
        const { poi, nsfw, modelVersions } = value;
        const images = modelVersions?.flatMap((x) => x?.images).filter(isDefined);
        setNsfwPoi(
          getIsNsfwPoi({
            poi,
            nsfw,
            images,
          })
        );
      }
    });
    return () => subscription.unsubscribe();
  }, [form]);
  // #endregion

  const tagsData = useMemo(() => {
    return [...tags.map((x) => x.name), ...(tagsOnModels ?? [])?.filter(isDefined)];
  }, [tagsOnModels, tags]);

  const mutating = addMutation.isLoading || updateMutation.isLoading;
  const [type, allowDerivatives] = form.watch(['type', 'allowDerivatives']);

  const acceptsTrainedWords = ['Checkpoint', 'TextualInversion', 'LORA'].includes(type);
  const isTextualInversion = type === 'TextualInversion';

  const handleSubmit = (values: FormSchema) => {
    function runMutation(options = { asDraft: false }) {
      const { asDraft } = options;

      const commonOptions = {
        async onSuccess(results: Model | undefined, input: { id?: number }) {
          const modelLink = `/models/${results?.id}/${slugit(results?.name ?? '')}`;

          showSuccessNotification({
            title: 'Your model was saved',
            message: `Successfully ${editing ? 'updated' : 'created'} the model.`,
          });
          await queryUtils.model.invalidate();
          await queryUtils.tag.invalidate();
          router.push({ pathname: modelLink, query: { showNsfw: true } }, modelLink, {
            shallow: !!input.id,
          });
        },
        onError(error: TRPCClientErrorBase<DefaultErrorShape>) {
          showErrorNotification({
            title: 'Could not save model',
            error: new Error(`An error occurred while saving the model: ${error.message}`),
          });
        },
      };

      const data: CreateModelProps | UpdateModelProps = {
        ...values,
        status: asDraft ? ModelStatus.Draft : values.status,
        allowDifferentLicense: values.allowDerivatives ? values.allowDifferentLicense : false,
        tagsOnModels: values.tagsOnModels?.map((name) => {
          const match = tags.find((x) => x.name === name);
          return match ?? { name };
        }),
        modelVersions: isTextualInversion
          ? values.modelVersions.map((version) => {
              const files = version.files ?? [];
              const hasNegativeFile = files.findIndex((file) => file.type === 'Negative') > -1;
              if (!hasNegativeFile) return version;

              const trainedWords = version.trainedWords ?? [];
              const [firstWord] = trainedWords;

              return {
                ...version,
                trainedWords: firstWord ? [firstWord, `${firstWord}-neg`] : [],
              };
            })
          : values.modelVersions,
      };

      if (editing) updateMutation.mutate(data as UpdateModelProps, commonOptions);
      else addMutation.mutate(data as CreateModelProps, commonOptions);
    }

    const versionWithoutFile = values.modelVersions.find((version) => version.files.length === 0);
    if (versionWithoutFile) {
      return openConfirmModal({
        title: (
          <Group spacing="xs">
            <IconAlertTriangle color="gold" />
            Missing model file
          </Group>
        ),
        centered: true,
        children: editing ? (
          `It appears that you've added a model without any files attached to it. Please upload the file or remove that version`
        ) : (
          <Text>
            This model will be saved as{' '}
            <Text span weight="bold">
              draft
            </Text>{' '}
            because your version{' '}
            <Text span weight="bold">
              {`"${versionWithoutFile.name}"`}
            </Text>{' '}
            is missing a model file. Do you wish to continue?
          </Text>
        ),
        labels: editing ? { confirm: 'Ok', cancel: 'Cancel' } : undefined,
        onConfirm() {
          if (editing) return;
          runMutation({ asDraft: true });
        },
      });
    }

    runMutation();
  };

  const handleModelTypeChange = (value: ModelType) => {
    switch (value) {
      case 'TextualInversion':
        fields.forEach((_, index) => {
          const modelVersion = form.getValues(`modelVersions.${index}`);
          const trainedWords = modelVersion.trainedWords ?? [];
          const [firstWord] = trainedWords;

          if (firstWord)
            form.setValue(`modelVersions.${index}.trainedWords`, [firstWord, `${firstWord}-neg`]);
        });
        break;
      case 'Hypernetwork':
      case 'AestheticGradient':
        fields.forEach((_, index) => {
          form.setValue(`modelVersions.${index}.trainedWords`, []);
          form.setValue(`modelVersions.${index}.skipTrainedWords`, true);
        });
        break;
      default:
        break;
    }
  };

  return (
    <Container>
      <Group spacing="lg" mb="lg">
        <ActionIcon variant="outline" size="lg" onClick={() => router.back()}>
          <IconArrowLeft size={20} stroke={1.5} />
        </ActionIcon>
        <Title order={3}>{model ? 'Editing model' : 'Upload model'}</Title>
      </Group>
      <Form
        form={form}
        onSubmit={handleSubmit}
        onError={() =>
          showErrorNotification({
            error: new Error('Please check the fields marked with red to fix the issues.'),
            title: 'Form Validation Failed',
          })
        }
      >
        <Grid gutter="xl">
          <Grid.Col lg={8}>
            <Stack>
              <Paper radius="md" p="xl" withBorder>
                <Stack>
                  <InputText name="name" label="Name" placeholder="Name" withAsterisk />
                  <InputRTE
                    name="description"
                    label="About your model"
                    description="Tell us what your model does"
                    includeControls={['heading', 'formatting', 'list', 'link', 'media']}
                    editorSize="md"
                  />
                </Stack>
              </Paper>
              <Group sx={{ justifyContent: 'space-between' }}>
                <Title order={4}>Model Versions</Title>
                <Button
                  size="xs"
                  leftIcon={<IconPlus size={16} />}
                  variant="outline"
                  onClick={() => prepend({ ...defaultModelVersion, uuid: uuidv4() })}
                  compact
                >
                  Add Version
                </Button>
              </Group>
              {/* Model Versions */}
              {fields.map((version, index) => {
                const trainedWords = form.watch(`modelVersions.${index}.trainedWords`) ?? [];
                const skipTrainedWords =
                  form.watch(`modelVersions.${index}.skipTrainedWords`) ?? false;
                const name = form.watch(`modelVersions.${index}.name`) ?? '';

                return (
                  <Paper
                    data-version-index={index}
                    key={version.id ?? index}
                    radius="md"
                    p="xl"
                    withBorder
                  >
                    <Stack style={{ position: 'relative' }}>
                      <Grid gutter="md">
                        <Grid.Col span={12}>
                          <Stack>
                            <Group noWrap align="flex-end" spacing="xs">
                              <InputText
                                name={`modelVersions.${index}.name`}
                                label="Name"
                                placeholder="Version Name"
                                withAsterisk
                                style={{ flex: 1 }}
                              />
                              {fields.length > 1 && (
                                <>
                                  {index < fields.length - 1 && (
                                    <ActionIcon
                                      variant="default"
                                      onClick={() => swap(index, index + 1)}
                                      size="lg"
                                    >
                                      <IconArrowDown size={16} />
                                    </ActionIcon>
                                  )}
                                  {index > 0 && (
                                    <ActionIcon
                                      variant="default"
                                      onClick={() => swap(index, index - 1)}
                                      size="lg"
                                    >
                                      <IconArrowUp size={16} />
                                    </ActionIcon>
                                  )}
                                  <ActionIcon
                                    color="red"
                                    onClick={() => remove(index)}
                                    variant="outline"
                                    size="lg"
                                  >
                                    <IconTrash size={16} stroke={1.5} />
                                  </ActionIcon>
                                </>
                              )}
                            </Group>
                            {name && name.toLowerCase().includes('safetensor') && (
                              <AlertWithIcon icon={<IconInfoCircle />}>
                                You can attach the SafeTensor file to an existing version, just add
                                a model file 😉
                              </AlertWithIcon>
                            )}
                            {name &&
                              (name.toLowerCase().includes('ckpt') ||
                                name.toLowerCase().includes('pickle')) && (
                                <AlertWithIcon icon={<IconInfoCircle />}>
                                  You can attach the ckpt file to an existing version, just add a
                                  model file 😉
                                </AlertWithIcon>
                              )}
                          </Stack>
                        </Grid.Col>
                        <Grid.Col span={12}>
                          <Group noWrap align="flex-end" spacing="xs">
                            <InputSelect
                              name={`modelVersions.${index}.baseModel`}
                              label="Base Model"
                              placeholder="Base Model"
                              withAsterisk
                              style={{ flex: 1 }}
                              data={constants.baseModels.map((x) => ({ value: x, label: x }))}
                            />
                          </Group>
                        </Grid.Col>
                        <Grid.Col span={12}>
                          <InputRTE
                            name={`modelVersions.${index}.description`}
                            label="Version changes or notes"
                            description="Tell us about this version"
                            includeControls={['formatting', 'list', 'link']}
                            editorSize="md"
                          />
                        </Grid.Col>
                        {acceptsTrainedWords && (
                          <Grid.Col span={12}>
                            <Stack spacing="xs">
                              {!skipTrainedWords && (
                                <InputMultiSelect
                                  name={`modelVersions.${index}.trainedWords`}
                                  label="Trigger Words"
                                  placeholder="e.g.: Master Chief"
                                  description={`Please input the words you have trained your model with${
                                    isTextualInversion ? ' (max 1 word)' : ''
                                  }`}
                                  data={trainedWords}
                                  getCreateLabel={(query) => `+ Create ${query}`}
                                  maxSelectedValues={type === 'TextualInversion' ? 1 : undefined}
                                  creatable
                                  clearable
                                  searchable
                                  required
                                />
                              )}
                              <InputSwitch
                                name={`modelVersions.${index}.skipTrainedWords`}
                                label="This version doesn't require any trigger words"
                                onChange={(e) =>
                                  e.target.checked
                                    ? form.setValue(`modelVersions.${index}.trainedWords`, [])
                                    : undefined
                                }
                              />
                            </Stack>
                          </Grid.Col>
                        )}
                        <Grid.Col span={6}>
                          <InputNumber
                            name={`modelVersions.${index}.epochs`}
                            label="Training Epochs"
                            placeholder="Training Epochs"
                            min={0}
                            max={1000}
                          />
                        </Grid.Col>
                        <Grid.Col span={6}>
                          <InputNumber
                            name={`modelVersions.${index}.steps`}
                            label="Training Steps"
                            placeholder="Training Steps"
                            min={0}
                            step={500}
                          />
                        </Grid.Col>
                        <Grid.Col span={12}>
                          <FileList parentIndex={index} form={form} />
                        </Grid.Col>
                        <Grid.Col span={12}>
                          <InputImageUpload
                            name={`modelVersions.${index}.images`}
                            label="Example Images"
                            max={20}
                            hasPrimaryImage
                            withAsterisk
                            onChange={(values) => {
                              const isBlocked = values.some((x) => x.status === 'blocked');
                              const isComplete = values
                                .filter((x) => x.status)
                                .every((x) => x.status === 'complete');
                              const isUploading = values.some((x) => x.status === 'uploading');
                              setUploading((state) => ({ ...state, [version.uuid]: isUploading }));
                              setBlocked((state) => ({ ...state, [version.uuid]: isBlocked }));
                              setComplete((state) => ({ ...state, [version.uuid]: isComplete }));
                            }}
                          />
                        </Grid.Col>
                      </Grid>
                    </Stack>
                  </Paper>
                );
              })}
            </Stack>
          </Grid.Col>
          <Grid.Col lg={4}>
            <Stack>
              <Paper radius="md" p="xl" withBorder>
                <Stack>
                  <Title order={4}>Model Properties</Title>
                  <InputSelect
                    name="status"
                    label="Status"
                    placeholder="Status"
                    data={[ModelStatus.Published, ModelStatus.Draft]}
                    withAsterisk
                  />
                  <InputSelect
                    name="type"
                    label="Type"
                    placeholder="Type"
                    data={Object.values(ModelType).map((type) => ({
                      label: splitUppercase(type),
                      value: type,
                    }))}
                    onChange={handleModelTypeChange}
                    withAsterisk
                  />

                  <InputMultiSelect
                    name="tagsOnModels"
                    label="Tags"
                    placeholder="e.g.: portrait, sharp focus, etc."
                    description="Please add your tags"
                    data={tagsData}
                    creatable
                    getCreateLabel={(query) => `+ Create ${query}`}
                    clearable
                    searchable
                  />
                </Stack>
              </Paper>
              <Paper radius="md" p="xl" withBorder>
                <Stack spacing="xs">
                  <Text size="sm" weight={500} sx={{ lineHeight: 1.2 }} mb="xs">
                    {`When using this model, I give permission for users to:`}
                  </Text>
                  <InputCheckbox name="allowNoCredit" label="Use without crediting me" />
                  <InputCheckbox name="allowDerivatives" label="Share merges of this model" />
                  {allowDerivatives && (
                    <InputCheckbox
                      name="allowDifferentLicense"
                      label="Use different permissions on merges"
                    />
                  )}

                  <Divider label="Commercial Use" labelProps={{ weight: 'bold' }} />
                  <InputSegmentedControl
                    name="allowCommercialUse"
                    orientation="vertical"
                    fullWidth
                    color="blue"
                    styles={(theme) => ({
                      root: {
                        border: `1px solid ${
                          theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[4]
                        }`,
                        background: 'none',
                      },
                    })}
                    data={[
                      {
                        value: CommercialUse.None,
                        label: (
                          <Group>
                            <IconCurrencyDollarOff size={16} /> None
                          </Group>
                        ),
                      },
                      {
                        value: CommercialUse.Image,
                        label: (
                          <Group>
                            <IconPhoto size={16} /> Sell generated images
                          </Group>
                        ),
                      },
                      {
                        value: CommercialUse.Rent,
                        label: (
                          <Group>
                            <IconBrush size={16} /> Use on generation services
                          </Group>
                        ),
                      },
                      {
                        value: CommercialUse.Sell,
                        label: (
                          <Group>
                            <IconShoppingCart size={16} /> Sell this model or merges
                          </Group>
                        ),
                      },
                    ]}
                  />
                </Stack>
              </Paper>
              <Paper radius="md" p="xl" withBorder>
                <Stack>
                  <Text size="sm" weight={500}>
                    {`This model:`}
                  </Text>
                  <InputCheckbox
                    name="poi"
                    label="Depicts an actual person"
                    description="For Example: Tom Cruise or Tom Cruise as Maverick"
                  />
                  <InputCheckbox name="nsfw" label="Is for an adult audience (NSFW)" />
                </Stack>
              </Paper>
              {nsfwPoi && (
                <>
                  <Alert color="red" pl={10}>
                    <Group noWrap spacing={10}>
                      <ThemeIcon color="red">
                        <IconExclamationMark />
                      </ThemeIcon>
                      <Text size="xs" sx={{ lineHeight: 1.2 }}>
                        NSFW content depicting actual people is not permitted.
                      </Text>
                    </Group>
                  </Alert>
                  <Text size="xs" color="dimmed" sx={{ lineHeight: 1.2 }}>
                    Please revise the content of this listing to ensure no actual person is depicted
                    in an NSFW context out of respect for the individual.
                  </Text>
                </>
              )}
              {isBlocked && (
                <>
                  <Alert color="red" pl={10}>
                    <Group noWrap spacing={10}>
                      <ThemeIcon color="red">
                        <IconExclamationMark />
                      </ThemeIcon>
                      <Text size="xs" sx={{ lineHeight: 1.2 }}>
                        TOS Violation
                      </Text>
                    </Group>
                  </Alert>
                  <Text size="xs" color="dimmed" sx={{ lineHeight: 1.2 }}>
                    Please revise the content of this listing to ensure no images contain content
                    that could constitute a TOS violation.
                  </Text>
                </>
              )}
              <Group position="right">
                <Button
                  variant="outline"
                  onClick={() => form.reset()}
                  disabled={!isDirty || mutating}
                >
                  Discard changes
                </Button>
                <Button type="submit" loading={mutating} disabled={nsfwPoi || !isComplete}>
                  {isUploading ? 'Uploading...' : mutating ? 'Saving...' : 'Save'}
                </Button>
              </Group>
            </Stack>
          </Grid.Col>
        </Grid>
      </Form>
    </Container>
  );
}
