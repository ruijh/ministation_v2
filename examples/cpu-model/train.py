"""Small reproducible Naive Bayes classifier, not an LLM. No external dependencies."""
import collections,json,math,pathlib,re
samples={
 'positive':['great excellent wonderful helpful good love happy','very good service thank you','满意 很好 优秀 喜欢 开心 推荐','good excellent helpful'],
 'negative':['bad awful terrible broken poor hate unhappy','very bad service disappointed','失望 糟糕 很差 讨厌 不满 差评','bad terrible broken']}
def tokens(text): return re.findall(r'[a-z]+|[\u4e00-\u9fff]',text.lower())
counts={k:collections.Counter(t for sentence in rows for t in tokens(sentence)) for k,rows in samples.items()}
vocab=sorted(set(t for c in counts.values() for t in c))
model={'name':'cpu-sentiment-naive-bayes','version':'1','tokenizer':'ascii-word-or-cjk-character','classes':{k:{'log_prior':math.log(.5),'log_probability':{t:math.log((c[t]+1)/(sum(c.values())+len(vocab))) for t in vocab},'unknown':math.log(1/(sum(c.values())+len(vocab)))} for k,c in counts.items()}}
pathlib.Path(__file__).with_name('model.json').write_text(json.dumps(model,ensure_ascii=False,indent=2),encoding='utf8')
print('Trained CPU classifier; 2 classes,',len(vocab),'features. Educational validation model only.')
