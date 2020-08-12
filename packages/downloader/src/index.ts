import axios from 'axios'

import * as unzip from 'unzipper'
import * as csv from 'csv-parse'
import * as transform from 'stream-transform'
import * as iconv from 'iconv-lite'
import * as archiver from 'archiver'
import { createWriteStream } from 'fs'

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
  for (const row of rows) {
    const address = rowToAddress(row)
    const path = postalCodeToPath(address.postalCode)

    context.archive.append(JSON.stringify(address), {
      name: `${path}.json`,
    })
  }

  await context.archive.finalize()
}

function createTransformCompletionHandler (outputPath: string): transform.Callback {
  return (error, data) => {
    if (error) {
      throw error
    }

    if (!data) {
      throw new Error('data is empty')
    }

    const destination = createWriteStream(outputPath)

    const archive = archiver('zip', {
      zlib: {
        level: 9,
      },
    })

    archive.pipe(destination)

    handleTransformResult(data as unknown as string[][], {
      archive,
    })
  }
}

function createTransformer (outputPath: string): transform.Transformer {
  return transform((record, callback) => {
    callback(null, record.map((c) => c.normalize('NFKC').trim()))
  }, createTransformCompletionHandler(outputPath))
}

async function handleCsvEntry (entry: unzip.Entry, outputPath: string) {
  entry
    .pipe(iconv.decodeStream('SJIS'))
    .pipe(iconv.encodeStream('UTF-8'))
    .pipe(csv())
    .pipe(createTransformer(outputPath))
}

function createEntryHandler (outputPath: string): (entry: unzip.Entry) => void {
  return (entry: unzip.Entry) => {
    if (entry.path !== 'KEN_ALL.CSV') {
      entry.autodrain()

      return
    }

    handleCsvEntry(entry, outputPath)
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

  response.data
    .pipe(unzip.Parse())
    .on('entry', createEntryHandler(configurations.outputPath))
}

download(config)
