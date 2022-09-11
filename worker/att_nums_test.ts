import { assertEquals, assertThrows } from 'https://deno.land/std@0.155.0/testing/asserts.ts';
import { AttNums } from './att_nums.ts';

Deno.test({
    name: 'AttNums',
    fn: () => {
        const attNums = new AttNums();
        assertEquals(attNums.get('id'), 0);
        assertEquals(attNums.get('id'), 0);
        assertEquals(attNums.get('name'), 1);
        assertEquals(attNums.get('id'), 0);
        assertEquals(attNums.get('description'), 2);

        assertEquals(attNums.toJson(), { id: 0, name: 1, description: 2 });
        assertEquals(AttNums.fromJson(attNums.toJson()).toJson(), attNums.toJson());

        assertEquals(attNums.packRecord({}), '');
        assertEquals(attNums.packRecord({ id: 'a' }), '\t0:a\t');
        assertEquals(attNums.packRecord({ name: 'foo', id: 'a' }), '\t1:foo\t0:a\t');
        assertEquals(attNums.packRecord({ id: 'a\tb' }), '\t0:ab\t');
        // deno-lint-ignore no-explicit-any
        assertThrows(() => attNums.packRecord({ foo: 2 } as any));

        assertEquals(attNums.unpackRecord(''), {});
        assertEquals(attNums.unpackRecord('\t0:a\t'), { id: 'a' });
        assertThrows(() => attNums.unpackRecord('0:a'));
        assertThrows(() => attNums.unpackRecord('\t'));
        assertThrows(() => attNums.unpackRecord('\t\t'));
        assertThrows(() => attNums.unpackRecord('\t0:a'));
        assertThrows(() => attNums.unpackRecord('0:a\t'));
        assertThrows(() => attNums.unpackRecord('\t0a\t1:b'));
        
        const roundtrip: Record<string, string>[] = [ 
            {}, 
            { id: 'a' }, 
            { id: 'a', name: 'foo' },
            { name: 'foo', id: 'a' },
        ];
        for (const record of roundtrip) {
            assertEquals(attNums.unpackRecord(attNums.packRecord(record)), record);
        }
    }
});
