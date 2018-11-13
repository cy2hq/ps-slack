const scrapper = require('x-ray')();
const axios = require('axios');
const {parse} = require('querystring');
const AWS = require('aws-sdk');
const sqs = new AWS.SQS({region: 'us-east-1'});
const {stringify} = require('flatted/cjs');
const empty200 = {statusCode: 200, body: ''};

const getOracleDocs = async (query) => {
  const baseUrl = 'https://docs.oracle.com/apps/search/search.jsp?q=';

  const url = `${baseUrl}${query}&product=${process.env.PRODUCT}`;

  const results = await scrapper(url, '.srch-result', [{
    title: '.srch-title',
    topic: '.topictitle',
    topic_link: '.topictitle@href',
    link: 'p span a@href',
    main: 'p',
  }]);

  const topFive = results.splice(0, 5);

  return topFive.map((item) => ({
    author_name: `${item.title} - ${item.topic}`,
    author_link: item.topic_link,
    title: item.link,
    title_link: item.link,
    text: item.main,
  }));
};

const getMosLinks = async (query) => {
  const baseUrl = process.env.MOSURL;

  const url = `${baseUrl}${encodeURIComponent(query)}`;
  const results = await scrapper(url, '.cb19', [{
    link: 'cite a@href',
  }]);

  return results.splice(0, 5).map((item) => item.link);
};

const sendResults = async (query, url, attachments)=>{
  let data;
  if (attachments.length === 0) {
    data = {text: 'sorry, I wasn\'t able to find anything'};
  } else {
    data = {text: `here are the results I found for: '${query}'`, attachments};
  }

  try {
    await axios.post(url, data);
  } catch (error) {
    console.error(`processEvent catch  ${stringify(error)}`);
  };

  return empty200;
};

const enqueueRequest= async (event, type) => {
  const body = parse(event.body);
  body.type = type;

  const params = {
    MessageBody: JSON.stringify(body),
    QueueUrl: process.env.QUEUE,
  };

  try {
    await sqs.sendMessage(params).promise();
  } catch (error) {
    console.error(error);
  }
  return {statusCode: 200, body: JSON.stringify({text: 'working on your request...'})};
};

const processMosCommand = async (text, url) => {
  const query = text.replace(' ', '+');
  const links = await getMosLinks(query);

  const getPage = async (url) => {
    return await scrapper(url, {items: ['p@html'], title: '.KM ', docid: '.KM docid'});
  };

  const pages = links.map((link) => getPage(link));
  const results = await Promise.all(pages);

  const items = results.map((item) => {
    const cleaned = [];
    for ( let i = 0; i < item.items.length -1; i++) {
      let line = item.items[i];
      line = line.replace(/<br>/gi, '\n').replace(/&#xA0;/gi, ' ');
      line = line.replace(/<hr>|<span[^>]*>|<\/span>|\r/gi, '');
      line = line.replace(/<strong>|<\/strong>/gi, '*');
      line = line.replace(/&quot;/gi, '"').replace(/&apos;/gi, '\'').replace(/\n\n+/g, '\n');
      line = line.replace(/  +/g, ' ').trim();

      /* skip the login sections */
      if (line.includes('<b>In this Document')) {
        break;
      }

      cleaned.push(line);
    }

    const text = cleaned.join('\n');
    return {title: item.title.replace('\n', ' - ').replace(/  +/g, ' '), docid: item.docid, text};
  });

  const attachments = items.map((item) => ({
    title: item.title.trim(),
    title_link: `https://support.oracle.com/epmos/faces/DocumentDisplay?id=${item.docid.substring(8, item.docid.length-1)}`,
    text: item.text,
  }));

  return await sendResults(text, url, attachments);
};

const processPbCommand = async (text, url) => {
  const query = encodeURIComponent(text);
  const attachments = await getOracleDocs(query);

  return await sendResults(text, url, attachments);
};


module.exports.pbCommand = async (event) => await enqueueRequest(event, 'pb');

module.exports.mosCommand = async (event) => await enqueueRequest(event, 'mos');

module.exports.commandHandler = async (event) => {
  const body = JSON.parse(event.Records[0].body);
  const text = body.text.toLowerCase().trim();
  const url = body.response_url;

  if (body.type === 'mos') {
    return await processMosCommand(text, url);
  }

  if (body.type ==='pb') {
    return await processPbCommand(text, url);
  }

  // bad command, log and ignore
  console.error(`invalid command type: ${body.type}`);
  return empty200;
};

module.exports.processMosCommand = async (event) => {
  const body = JSON.parse(event.Records[0].body);
  const text = body.text.toLowerCase().trim();
  const query = text.replace(' ', '+');
  const links = await getMosLinks(query);

  const getPage = async (url) => {
    return await scrapper(url, {items: ['p@html'], title: '.KM ', docid: '.KM docid'});
  };

  const pages = links.map((link) => getPage(link));
  const results = await Promise.all(pages);

  const items = results.map((item) => {
    const cleaned = [];
    for ( let i = 0; i < item.items.length -1; i++) {
      let line = item.items[i];
      line = line.replace(/<br>/gi, '\n').replace(/&#xA0;/gi, ' ');
      line = line.replace(/<hr>|<span[^>]*>|<\/span>|\r/gi, '');
      line = line.replace(/<strong>|<\/strong>/gi, '*');
      line = line.replace(/&quot;/gi, '"').replace(/&apos;/gi, '\'').replace(/\n\n+/g, '\n');
      line = line.replace(/  +/g, ' ').trim();

      if (line.includes('<b>In this Document')) {
        break;
      }
      cleaned.push(line);
    }
    const text = cleaned.join('\n');
    return {title: item.title.replace('\n', ' - ').replace(/  +/g, ' '), docid: item.docid, text};
  });

  const attachments = items.map((item) => ({
    title: item.title.trim(),
    title_link: `https://support.oracle.com/epmos/faces/DocumentDisplay?id=${item.docid.substring(8, item.docid.length-1)}`,
    text: item.text,
  }));

  return await sendResults(text, body.response_url, attachments);
};
