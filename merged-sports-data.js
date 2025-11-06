const fs = require('fs');
const https = require('https');

// 获取上海时间
function getShanghaiTime() {
  const now = new Date();
  const shanghaiTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return shanghaiTime.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

// 获取当前日期（用于过滤）
function getTodayDate() {
  const now = new Date();
  const shanghaiTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const month = shanghaiTime.getMonth() + 1;
  const day = shanghaiTime.getDate();
  return `${month}月${day}日`;
}

async function fetchWithRetry(url, options, maxRetries = 2) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const req = https.get(url, options, (res) => {
          let data = '';
          
          res.on('data', (chunk) => {
            data += chunk;
          });
          
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ status: res.statusCode, data });
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
            }
          });
        });
        
        req.on('error', reject);
        req.setTimeout(10000, () => {
          req.destroy();
          reject(new Error('Request timeout'));
        });
      });
    } catch (error) {
      console.warn(`请求失败 (尝试 ${attempt}/${maxRetries}):`, error.message);
      if (attempt === maxRetries) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

// 第一步：获取并解析M3U列表
async function getM3UData() {
  try {
    console.log('📡 获取M3U列表数据...');
    const response = await fetchWithRetry('https://bingcha.hxfkof88.cloudns.ch/');
    const m3uText = response.data;
    
    const m3uData = [];
    const lines = m3uText.split('\n');
    let currentTitle = '';
    let currentUrl = '';
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;
      
      if (trimmedLine.startsWith('#EXTINF:')) {
        // 检查group-title是否为冰茶体育或咪咕备用
        const groupMatch = trimmedLine.match(/group-title="([^"]*)"/);
        if (groupMatch && (groupMatch[1] === '冰茶体育' || groupMatch[1] === '咪咕备用')) {
          const titleMatch = trimmedLine.match(/,(.*)$/);
          if (titleMatch) {
            currentTitle = titleMatch[1].trim();
          }
        } else {
          currentTitle = ''; // 不符合条件，清空title
        }
      } else if (trimmedLine.startsWith('http') && currentTitle) {
        currentUrl = trimmedLine;
        
        // 格式化标题：提取时间并标准化格式
        const timeMatch = currentTitle.match(/(\d{1,2})月(\d{1,2})日(\d{1,2}:\d{2})/);
        if (timeMatch) {
          const month = timeMatch[1].padStart(2, '0');
          const day = timeMatch[2].padStart(2, '0');
          const time = timeMatch[3];
          const formattedTime = `${month}月${day}日${time}`;
          
          // 获取标题的其他部分（去掉时间），并去掉_和空格
          const titleWithoutTime = currentTitle
            .replace(/(\d{1,2})月(\d{1,2})日(\d{1,2}:\d{2})_?/, '') // 去掉时间部分
            .replace(/_/g, '') // 去掉所有下划线
            .replace(/\s+/g, '') // 去掉所有空格
            .trim();
          
          m3uData.push({
            title: currentTitle,
            formattedTime: formattedTime,
            titleWithoutTime: titleWithoutTime,
            url: currentUrl
          });
        }
        
        currentTitle = '';
        currentUrl = '';
      }
    }
    
    console.log(`✅ 成功解析M3U数据，共 ${m3uData.length} 条记录`);
    
    // 输出前几条记录作为示例
    if (m3uData.length > 0) {
      console.log('📋 M3U数据示例:');
      for (let i = 0; i < Math.min(3, m3uData.length); i++) {
        const item = m3uData[i];
        console.log(`   ${item.formattedTime} - ${item.titleWithoutTime}`);
      }
    }
    
    return m3uData;
    
  } catch (error) {
    console.error('❌ 获取M3U数据失败:', error.message);
    return [];
  }
}

// 第二步：匹配数据
function matchData(sportsData, m3uData) {
  const todayDate = getTodayDate();
  console.log(`📅 过滤今天(${todayDate})的比赛数据...`);
  
  // 过滤出今天的比赛
  const todayMatches = sportsData.data.filter(match => {
    return match.keyword && match.keyword.includes(todayDate);
  });
  
  console.log(`📊 今天共有 ${todayMatches.length} 场比赛`);
  
  const matchedResults = [];
  
  for (const match of todayMatches) {
    const matchedMatch = {
      ...match,
      nodes: []
    };
    
    // 为每个节点匹配M3U链接
    for (const node of match.nodes) {
      const matchedNode = {
        ...node,
        urls: [] // 存储匹配的URL
      };
      
      // 构建匹配关键词
      const matchTime = match.keyword; // 如 "11月06日11:00"
      const competitionInfo = (match.modifyTitle || match.title || '').replace(/_/g, '').replace(/\s+/g, '');
      const teamsInfo = (match.pkInfoTitle || '').replace(/_/g, '').replace(/\s+/g, '');
      const nodeName = node.name.replace(/_/g, '').replace(/\s+/g, '');
      
      // 在M3U数据中查找匹配项
      for (const m3uItem of m3uData) {
        // 1. 时间必须完全匹配
        if (m3uItem.formattedTime !== matchTime) {
          continue;
        }
        
        // 2. 节点名称必须在M3U标题的末尾匹配
        const m3uTitle = m3uItem.titleWithoutTime;
        if (!m3uTitle.endsWith(nodeName)) {
          continue;
        }
        
        // 3. 检查中间部分是否大部分匹配
        const middlePart = m3uTitle.slice(0, -nodeName.length);
        const expectedMiddle = `${competitionInfo}${teamsInfo}`;
        
        // 简单的相似度检查：检查关键词是否包含在中间部分
        const competitionWords = competitionInfo.split('').filter(word => word.length > 0);
        const teamsWords = teamsInfo.split('').filter(word => word.length > 0);
        
        let matchScore = 0;
        let totalWords = competitionWords.length + teamsWords.length;
        
        for (const word of competitionWords) {
          if (middlePart.includes(word)) {
            matchScore++;
          }
        }
        
        for (const word of teamsWords) {
          if (middlePart.includes(word)) {
            matchScore++;
          }
        }
        
        // 如果匹配度超过50%，认为匹配成功
        if (totalWords > 0 && matchScore / totalWords >= 0.5) {
          matchedNode.urls.push(m3uItem.url);
        }
      }
      
      matchedMatch.nodes.push(matchedNode);
    }
    
    matchedResults.push(matchedMatch);
  }
  
  return matchedResults;
}

// 主执行函数
async function main() {
  try {
    console.log('🚀 开始合并当天体育比赛数据...');
    
    // 第一步：获取M3U数据
    const m3uData = await getM3UData();
    if (m3uData.length === 0) {
      console.log('❌ 没有获取到M3U数据，程序退出');
      return;
    }
    
    // 第二步：读取本地体育数据
    console.log('📖 读取本地体育数据...');
    let sportsData;
    try {
      const sportsDataFile = fs.readFileSync('sports-data-latest.json', 'utf8');
      sportsData = JSON.parse(sportsDataFile);
      console.log(`✅ 成功读取体育数据，共 ${sportsData.data.length} 场比赛`);
    } catch (error) {
      console.error('❌ 读取体育数据失败:', error.message);
      return;
    }
    
    // 第三步：匹配数据
    console.log('🔍 开始匹配数据...');
    const matchedResults = matchData(sportsData, m3uData);
    
    // 第四步：保存结果
    const finalData = {
      success: true,
      updateTime: getShanghaiTime(),
      data: matchedResults
    };
    
    const filename = `merged-sports-data-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(filename, JSON.stringify(finalData, null, 2));
    fs.writeFileSync('merged-sports-data-latest.json', JSON.stringify(finalData, null, 2));
    
    console.log(`✅ 数据合并完成！`);
    console.log(`📊 今天共匹配 ${matchedResults.length} 场比赛`);
    console.log(`💾 数据已保存到: ${filename} 和 merged-sports-data-latest.json`);
    
    // 输出匹配统计
    let totalNodes = 0;
    let matchedNodes = 0;
    
    for (const match of matchedResults) {
      totalNodes += match.nodes.length;
      for (const node of match.nodes) {
        if (node.urls.length > 0) {
          matchedNodes++;
        }
      }
    }
    
    console.log(`📺 节点匹配情况: ${matchedNodes}/${totalNodes} (${((matchedNodes / totalNodes) * 100).toFixed(1)}%)`);
    
  } catch (error) {
    console.error('❌ 执行失败:', error);
  }
}

// 如果直接运行此文件
if (require.main === module) {
  main();
}

module.exports = { getM3UData, matchData };
