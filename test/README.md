```bash
npm install

# term1
# export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 all_proxy=socks5://127.0.0.1:7890
# export DB_PATH=./.data/ai.db PORT=18040
npx tsx test/h3.ts

# term2
npx serve client -s -l 18041
```
