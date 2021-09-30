import express from 'express';
import axiosBase from 'axios';
import dayjs from 'dayjs';
import * as child_process from 'child_process';
import { Record } from './entities/Record';
import { getConnectionOptions, createConnection, BaseEntity } from 'typeorm';
import schedule from 'node-schedule';

const expressApp = async () => {
    const app: express.Express = express();
    const port = 4000;
    // 実際のts動画ファイルを提供しているサーバー
    const AGServer = `https://icraft.hs.llnwd.net`;
    // m3u8ファイルを提供しているサーバー
    const m3u8BaseURL = `https://fms2.uniqueradio.jp`;

    // --- TypeORMの設定
    const connectionOptions = await getConnectionOptions();
    const connection = await createConnection(connectionOptions);

    BaseEntity.useConnection(connection);

    // CORSの許可
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        next();
    });
    // body-parserに基づいた着信リクエストの解析
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    app.get('/', async (req, res) => {
        const records = await Record.find();
        res.send(records);
    });

    // ffmpeg等へ録画を始めるためのm3u8ファイルを提供
    app.get('/start.m3u8', (req, res) => {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        const finalM3u8 = `#EXTM3U\n#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=242455\nhttp://localhost:${port}/aandg1.m3u8`;
        res.status(200).send(finalM3u8);
    });

    // ffmpeg等へA&Gサーバからの内容を書き換えて最新のm3u8ファイルを提供．
    app.get('/aandg1.m3u8', (req, res) => {
        const axios = axiosBase.create({
            baseURL: m3u8BaseURL,
        });
        axios
            .get('agqr10/aandg1.m3u8')
            .then(function (response) {
                const finalM3u8 = response.data.replace(/(aandg1-[0-9]{13}.ts)/g, `${AGServer}/agqr10/$1`);
                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                res.status(200).send(finalM3u8);
            })
            .catch(function (error) {
                res.status(500).json({ error: 'ERROR!! occurred in Backend.' });
                console.log('ERROR!! occurred in Backend.\n' + error);
            });
    });

    // ffmpegで録画を実行．
    app.get('/record', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (!req.query.time || !req.query.name) {
            res.status(400).json({
                error: 'timeとnameパラメータを指定してください．',
            });
            return;
        }
        startRecord(parseInt(req.query.time as string), req.query.name as string);
        res.status(200).json({ message: 'OK' });
    });

    // 番組表APIへ代理アクセスして返却
    app.get('/all', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        const axios = axiosBase.create({
            baseURL: `https://agqr.sun-yryr.com/api`,
            headers: {
                'Content-Type': 'application/json',
            },
            responseType: 'json',
        });
        axios
            .get('all?isRepeat=true')
            .then(function (response) {
                console.log(response.data);
                res.status(200).json(response.data);
            })
            .catch(function (error) {
                res.status(500).json({ error: 'ERROR!! occurred in Backend.' });
                console.log('ERROR!! occurred in Backend.\n' + error);
            });
    });

    /*
    // 予約録画を受け付ける
    // name: 番組名
    // start: 2021-09-27T11:23:30
    // length: 秒
    */
    app.get('/schedule', async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (!req.query.start || !req.query.name || !req.query.length) {
            res.status(400).json({
                error: 'length,name,startパラメータを指定してください．',
            });
            return;
        }

        const start = req.query.start as string;
        if (!start.match(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}/)) {
            res.status(400).json({
                error: 'startパラメータが不正です．例：2021-09-27T11:23:30',
            });
            return;
        }

        if (dayjs().isAfter(dayjs(start))) {
            res.status(400).json({
                error: '指定された録画開始時刻を過ぎています．',
            });
            return;
        }

        const length = Number(req.query.length);
        if (isNaN(length) || length <= 0) {
            res.status(400).json({
                error: 'lengthパラメータが不正です．正の数のみ受け付けます．',
            });
            return;
        }

        if (await checkRecord(dayjs(start).toDate())) {
            res.status(400).json({
                error: '既に予約済みです．',
            });
            return;
        }

        addRecordingSchedule(req.query.name as string, dayjs(start).toDate(), length);

        res.status(200).json({ message: 'OK' });
    });

    // 予約情報を返却
    app.get('/scheduleInfo', async (req, res) => {
        const records = await Record.find();
        res.status(200).json(records);
    });

    app.listen(port, () => {
        console.log(`Example app listening on port ${port}`);
    });

    /*
    // 録画を開始する関数
    // outputName: 出力ファイル名
    // programTimeLength: 秒
    */
    function startRecord(programTimeLength: number, outputName: string) {
        // 記号をエスケープ（インジェクション対策）
        outputName = outputName.replace(/[!-,:-@[-^'{-~/ ]/g, ``);
        child_process.spawn('ffmpeg', [
            '-protocol_whitelist',
            'file,http,https,tcp,tls,crypto',
            '-t',
            String(programTimeLength),
            '-i',
            `http://localhost:${port}/start.m3u8`,
            `recorded/${outputName}`,
        ]);
    }

    /* 録画予約をする関数
    // programName: 番組名
    // recordStartTime: 番組開始時間
    // programTimeLength: 秒
    */
    async function addRecordingSchedule(programName: string, recordStartTime: Date, programTimeLength: number) {
        if (dayjs().isAfter(dayjs(recordStartTime))) {
            console.log('指定された録画開始時刻を過ぎています．');
            return;
        }

        schedule.scheduleJob(recordStartTime, async function () {
            console.log(
                `録画開始\n番組名：${programName}\n録画開始時間：${dayjs(recordStartTime).format(
                    'YYYY年MM月DD日HH時mm分'
                )}\n番組の長さ：${programTimeLength}`
            );

            const record = await Record.findOne({
                program_name: programName,
                start_time: recordStartTime,
                program_length: programTimeLength,
                recorded: false,
            });

            if (record) {
                record.recorded = true;
                await record.save();
            }

            // 出力ファイル名
            const outputName = `${dayjs(recordStartTime).format('YYYY年MM月DD日HH時mm分')}_${programName}.mp4`;
            startRecord(programTimeLength, outputName);
        });

        if (!(await checkRecord(recordStartTime))) {
            // DBに情報を追加
            const record = new Record();
            record.program_name = programName;
            record.start_time = recordStartTime;
            record.program_length = programTimeLength;
            record.recorded = false;
            await record.save();
        }

        console.log(
            `録画受付\n番組名：${programName}\n録画開始時間：${dayjs(recordStartTime).format(
                'YYYY年MM月DD日HH時mm分'
            )}\n番組の長さ：${programTimeLength}`
        );
    }

    /* 
    // 指定時間に予約がすでに入っているかを確認する
    // recordStartTime: 番組開始時間
    */
    async function checkRecord(recordStartTime: Date) {
        const records = await Record.find({
            start_time: recordStartTime,
        });
        return records.length > 0;
    }

    /* 
    // 起動時に実行する．DBに入っている予約情報をジョブに再登録する．
    */
    async function startProcess() {
        const records = await Record.find({
            recorded: false,
        });
        records.forEach((elm) => {
            addRecordingSchedule(elm.program_name, elm.start_time, elm.program_length);
        });
    }
    startProcess();
};

expressApp();
