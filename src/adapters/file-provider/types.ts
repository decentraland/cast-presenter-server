export interface FileProviderResult {
  buffer: Buffer
  filename: string
  fields: Record<string, string>
}

export interface IFileProviderComponent {
  fromMultipart(contentType: string, body: Buffer): Promise<FileProviderResult>
  fromUrl(url: string): Promise<FileProviderResult>
}
