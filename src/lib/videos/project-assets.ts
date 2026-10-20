export interface StorageEntry {
  name: string;
  id: string | null;
}

export interface ProjectAssetBucket {
  list(
    path: string,
    options?: { limit?: number; offset?: number },
  ): PromiseLike<{
    data: StorageEntry[] | null;
    error: { message: string } | null;
  }>;
  remove(paths: string[]): PromiseLike<{
    error: { message: string } | null;
  }>;
}

export async function removeProjectAssets(
  bucket: ProjectAssetBucket,
  projectId: string,
): Promise<void> {
  const folders = [projectId];
  const files: string[] = [];

  while (folders.length > 0) {
    const folder = folders.pop();
    if (!folder) continue;

    let offset = 0;
    while (true) {
      const { data, error } = await bucket.list(folder, { limit: 1000, offset });
      if (error) throw new Error(`Could not list video assets: ${error.message}`);

      const entries = data ?? [];
      for (const entry of entries) {
        const path = `${folder}/${entry.name}`;
        if (entry.id === null) folders.push(path);
        else files.push(path);
      }

      if (entries.length < 1000) break;
      offset += entries.length;
    }
  }

  for (let index = 0; index < files.length; index += 100) {
    const { error } = await bucket.remove(files.slice(index, index + 100));
    if (error) throw new Error(`Could not remove video assets: ${error.message}`);
  }
}
