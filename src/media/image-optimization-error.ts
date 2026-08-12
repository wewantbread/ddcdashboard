/** Internal signal that image optimization could not satisfy its final byte budget. */
export class ImageOptimizationLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageOptimizationLimitError";
  }
}
