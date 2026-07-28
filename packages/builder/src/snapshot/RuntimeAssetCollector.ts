export interface RuntimeAsset { url: string; type?: string; localPath?: string; critical?: boolean; }
export class RuntimeAssetCollector {
  public collect(resources: Array<{ sourceUrl?: string; localPath?: string; contentType?: string }>): RuntimeAsset[] {
    return resources.filter((resource) => Boolean(resource.sourceUrl)).map((resource) => ({ url: resource.sourceUrl!, localPath: resource.localPath, type: resource.contentType, critical: /css|font|javascript|image/.test(resource.contentType ?? '') }));
  }
}
