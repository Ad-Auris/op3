import { assertEquals, assertThrows } from './tests/deps.ts';
import { parsePubdate } from './pubdates.ts';

Deno.test({
    name: 'pubdates',
    fn: () => {
        const good = {
            'Tue, 09 Nov 2021 17:08:12 GMT': '2021-11-09T17:08:12.000Z',
            'Tue, 09 Nov 2021 17:08:12 gmt': '2021-11-09T17:08:12.000Z',
            'Tue, 09 Nov 2021 17:08:12 UTc': '2021-11-09T17:08:12.000Z',
            'Fri, 10 Jul 2020 06:00:00 -0000': '2020-07-10T06:00:00.000Z',
            '2022-10-13T14:56:23-07:00': '2022-10-13T21:56:23.000Z',
            'Sun, 4 Dec 2022 14:30:00 CEST': '2022-12-04T13:30:00.000Z',
            'Sun, 4 Dec 2022 14:30:00 CET': '2022-12-04T13:30:00.000Z',
            'Sun, 10 Jul 2022 14:30:00 CEST': '2022-07-10T12:30:00.000Z',
            'Fri, 14 Jul 2023 19:00:00 PDT': '2023-07-15T02:00:00.000Z',
            'Sun, 11 Jun 2023 17:10:00 EDT': '2023-06-11T21:10:00.000Z',
            '2023-07-17 12:00:00 +0000': '2023-07-17T12:00:00.000Z',
            'Tue, 30 May 2023 18:07:06 UT': '2023-05-30T18:07:06.000Z',
            'Fri, 07 Jul 2023 15:00:00 CDT': '2023-07-07T20:00:00.000Z',
            '02/03/2023 06:34:00': '2023-02-03T06:34:00.000Z',
            'Fri, 16 Jun 2017 13:00:00 MDT': '2017-06-16T19:00:00.000Z',
            'Wed, 19 Jul 2023 22:48:03 Z': '2023-07-19T22:48:03.000Z',
            'Fri, 7 Ju1 2023 02:00:00 GMT': '2023-07-07T02:00:00.000Z',
        };
        for (const [ input, expected ] of Object.entries(good)) {
            assertEquals(parsePubdate(input), expected);
        }

        const bad = [ '0', '', 'a' ];
        for (const input of bad) {
            assertThrows(() => parsePubdate(input));
        }
    }
});
