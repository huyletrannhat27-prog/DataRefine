import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluateHoldout, fitProfile } from '../engine.mjs';
import { readDataset } from '../tabular.mjs';

const directory = process.argv[2];
if (!directory) throw Error('Usage: node scripts/train-kaggle.mjs <directory of extracted Kaggle datasets>');
const datasets = [
  {
    file:'iris/Iris.csv', label:'Iris Species', target:'species', requestedType:'category',
    ignored:['id'], candidates:[['petallengthcm','petalwidthcm'],['sepallengthcm','sepalwidthcm','petallengthcm','petalwidthcm']],
    url:'https://www.kaggle.com/datasets/uciml/iris'
  },
  {
    file:'wine/winequality-red.csv', label:'Red Wine Quality', target:'quality', requestedType:'number',
    ignored:[], candidates:[
      ['alcohol','volatile_acidity','sulphates'], ['alcohol','volatile_acidity','sulphates','citric_acid','density'],
      ['alcohol','volatile_acidity','sulphates','citric_acid','total_sulfur_dioxide','chlorides'],
      ['fixed_acidity','volatile_acidity','citric_acid','residual_sugar','chlorides','free_sulfur_dioxide',
        'total_sulfur_dioxide','density','ph','sulphates','alcohol']
    ],
    url:'https://www.kaggle.com/datasets/uciml/red-wine-quality-cortez-et-al-2009'
  },
  {
    file:'penguins/penguins_size.csv', label:'Palmer Penguins', target:'species', requestedType:'category',
    ignored:[], missingToken:'NA', candidates:[
      ['culmen_length_mm','culmen_depth_mm','flipper_length_mm','body_mass_g'],
      ['culmen_length_mm','culmen_depth_mm','flipper_length_mm']
    ],
    url:'https://www.kaggle.com/datasets/parulpandey/palmer-archipelago-antarctica-penguin-data'
  },
  {
    file:'powerlifting/meets.csv', label:'OpenPowerlifting Meets', target:'meetcountry', requestedType:'category',
    ignored:['meetid','meetpath'], candidates:[['federation'],['federation','meetstate']],
    url:'https://www.kaggle.com/datasets/open-powerlifting/powerlifting-database/versions/1'
  }
];

const starters = [];
for (const config of datasets) {
  const path = resolve(directory,config.file);
  const partitions = Array.from({length:3},() => ({ rows:[], keys:[] }));
  let headers, groupIndices;
  for await (const original of readDataset(path,'CSV')) {
    const row = config.missingToken ? original.map(value => value === config.missingToken ? '' : value) : original;
    if (!headers) {
      headers = row;
      groupIndices = headers.flatMap((name,index) => config.ignored.includes(name) || name === config.target ? [] : [index]);
      continue;
    }
    const key = createHash('sha256').update(JSON.stringify(groupIndices.map(index => row[index].trim()))).digest();
    const bucket = key.readUInt32BE() % 100;
    const part = partitions[bucket < 70 ? 0 : bucket < 85 ? 1 : 2];
    part.rows.push(row);
    part.keys.push(createHash('sha256').update(key).update(row[headers.indexOf(config.target)]).digest('hex'));
  }
  const [train,validate,test] = partitions.map((part,index) => {
    const limit = index === 0 ? 2000 : 600;
    const ranked = part.keys.map((key,i) => ({key,row:part.rows[i]}));
    ranked.sort((a,b) => a.key.localeCompare(b.key));
    const sample = ranked.slice(0,limit);
    return { headers, rows:sample.map(entry => entry.row), keys:sample.map(entry => entry.key) };
  });
  const models = config.candidates.map(featureNames => fitProfile({ ...config, featureNames, train, validate }));
  const error = profile => profile.metrics.errorRate ?? profile.metrics.mae;
  const profile = models.filter(p => p.metrics.eligible).sort((a,b) => error(a)-error(b))[0];
  if (!profile) {
    console.log(config.label + ' skipped because no model met the validation requirements.');
    continue;
  }
  profile.metrics.holdout = evaluateHoldout(profile,test);
  profile.source = {
    url:config.url,
    sha256:createHash('sha256').update(await readFile(path)).digest('hex'),
    file:config.file.split('/').at(-1)
  };
  starters.push(profile);
  console.log(JSON.stringify({ dataset:config.label, rows:partitions.map(part => part.rows.length),
    target:profile.target, features:profile.model.features.map(f => f.name), metrics:profile.metrics, source:profile.source }));
}
if (!starters.length) throw Error('No eligible Kaggle profiles were produced.');
await writeFile(new URL('../models/kaggle-profiles.json',import.meta.url),JSON.stringify(starters) + '\n','utf8');
