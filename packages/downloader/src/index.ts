import axios from 'axios'

import * as unzip from 'unzipper'
import * as csv from 'csv-parse'
import * as transform from 'stream-transform'
import * as iconv from 'iconv-lite'
import archiver from 'archiver'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'

import * as config from './config.json'

interface AddressObject {
  postalCode: string;
  prefKana: string;
  address1Kana: string;
  address2Kana: string;
  pref: string;
  address1: string;
  address2: string;
}

function rowToAddress (row: string[]): AddressObject {
  const [,,
    postalCode,
    prefKana, address1Kana, address2Kana,
    pref, address1, address2,
  ] = row

  return {
    postalCode,
    prefKana,
    address1Kana,
    address2Kana,
    pref,
    address1,
    address2,
  }
}

function postalCodeToPath (postalCode: string): string {
  return postalCode.replace(/^(\d{3})/, '$1/')
}

async function handleTransformResult (rows: string[][], context: { archive: archiver.Archiver }) {
  const archive: Record<string, AddressObject[]> = {}

  for (const row of rows) {
    const address = rowToAddress(row)
    const path = postalCodeToPath(address.postalCode)

    if (!archive[path]) {
      archive[path] = []
    }

    archive[path].push(address)
  }

  Object.entries(archive).forEach(([path, addresses]) => {
    context.archive.append(JSON.stringify(addresses), {
      name: `${path}.json`,
    })
  })

  await context.archive.finalize()
}

function createTransformCompletionHandler (outputPath: string, onComplete: () => void, onError: (error: unknown) => void): transform.Callback {
  return async (error, data) => {
    if (error) {
      return onError(error)
    }

    if (!data) {
      return onError(new Error('data is empty'))
    }

    const destination = createWriteStream(outputPath)

    const archive = archiver('zip', {
      zlib: {
        level: 9,
      },
    })

    archive.pipe(destination)
      .on('error', onError)

    try {
      await handleTransformResult(data as unknown as string[][], {
        archive,
      })

      onComplete()
    } catch (error) {
      onError(error)
    }
  }
}

function normalize (str: string): string {
  return str.normalize('NFKC')
    .replace(/\u3000/g, '')
    .replace(/（.*/, '')
    .replace(/\(.*/, '')
    .replace(/.*場合$/, '')
    .replace(/.*バアイ$/i, '')
    .replace(/.*一円$/, '')
    .replace(/.*イチエン$/i, '')
    .trim()
}

function createTransformer (outputPath: string, onComplete: () => void, onError: (error: unknown) => void): transform.Transformer {
  return transform.transform((record, callback) => {
    callback(null, record.map(normalize))
  }, createTransformCompletionHandler(outputPath, onComplete, onError))
}

async function handleCsvEntry (entry: unzip.Entry, outputPath: string) {
  return new Promise<void>(async (resolve, reject) => {
    try {
      await pipeline([
        entry,
        iconv.decodeStream('SJIS'),
        csv.parse(),
        createTransformer(outputPath, resolve, reject),
      ])
    } catch (error) {
      reject(error)
    }
  })
}

function createEntryHandler (outputPath: string, onComplete: () => void, onError: (error: unknown) => void): (entry: unzip.Entry) => void {
  return (entry: unzip.Entry) => {
    if (entry.path !== 'KEN_ALL.CSV') {
      entry.autodrain()
        .on('error', onError)

      return
    }

    handleCsvEntry(entry, outputPath)
      .then(onComplete)
      .catch(onError)
  }
}

interface Configurations {
  kenAllUrl: string;
  outputPath: string;
}

async function download (configurations: Configurations) {
  const response = await axios.get(configurations.kenAllUrl, {
    responseType: 'stream',
  })

  return new Promise<void>((resolve, reject) => {
    response.data
      .pipe(unzip.Parse())
      .on('entry', createEntryHandler(configurations.outputPath, resolve, reject))
      .on('error', reject)
  })
}

download(config)
  .catch((error) => {
    console.error(error)

    process.exitCode = 1
  })
