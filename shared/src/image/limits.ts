/**
 * "3.75 MB" in the Converse docs, with no unit base stated. The decimal reading is the
 * stricter of the two, so it satisfies the limit whichever one Bedrock means.
 * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Message.html
 */
export const INPUT_IMAGE_MAX_BYTES = 3_750_000;
