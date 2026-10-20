/** Verificador Groth16 generado por snarkjs para las ocho señales públicas del protocolo. */
// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract Groth16Verifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 7367236174164300882715672593940174255599737113637056937968963875522419113362;
    uint256 constant alphay  = 10196741307646465263859017943556625627062062305836558146795888444471465289933;
    uint256 constant betax1  = 79072677349780213015270354049497166499794757802742442996303594775726091507;
    uint256 constant betax2  = 17831780873850371373821565871688127440259276400307262665159623968892858463841;
    uint256 constant betay1  = 8695218826638066961679338876300334608505434576430482278315957442080688337312;
    uint256 constant betay2  = 136765819734520141512087213530527647661511630429089641529646431805152408549;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 18297114085801449393460597608213921949896135104707834576052722138437783193939;
    uint256 constant deltax2 = 7394684239255869998301373137302290846559289086291738048184874618052548207189;
    uint256 constant deltay1 = 3407542603574967644529445581154420163140907354154295878837593693385777820777;
    uint256 constant deltay2 = 5871209294978532888335990433385823926592367925519556332580706284392600630296;

    
    uint256 constant IC0x = 12942764712103123643684886153614907204534865721136364169871282823585059182038;
    uint256 constant IC0y = 7702906846735312322301619843804369845169198984754549163778191993150621192040;
    
    uint256 constant IC1x = 10016174345967697334536980784848532205628238413783132754434627440378259846622;
    uint256 constant IC1y = 11155067156604331167829655956652664644781637546951273873535653422015790413657;
    
    uint256 constant IC2x = 10310637967764602020326234382264999590453509579209702487943770099331882089428;
    uint256 constant IC2y = 3373412287609842645716083459817931319435814467288341597115566865690495123662;
    
    uint256 constant IC3x = 18481957467644227983939876588036480985503219931855456176850207846698162579917;
    uint256 constant IC3y = 7864692272635813173331532632472700973191040868585737908506335777166140967132;
    
    uint256 constant IC4x = 18114864490413533834464255589798606427674641566410574623874331298408086649417;
    uint256 constant IC4y = 13883888340794448983560754184732835437000018065256084975127614098748425114419;
    
    uint256 constant IC5x = 10333060993677192435597577672590595019699573509489333315544636309847594469688;
    uint256 constant IC5y = 5249424628558362320106391959098189081009095969612806139226925362588817321539;
    
    uint256 constant IC6x = 20196258096066057396329067051889452857020770537437983903439730602896187429259;
    uint256 constant IC6y = 10860840003738042249611193120736959004554640816088013445511025986668361325514;
    
    uint256 constant IC7x = 3747085612815304983731484350519714268346931123022932128622205010177039200798;
    uint256 constant IC7y = 6801447519137445203248841641184655534690343147260768540533149579994269553793;
    
    uint256 constant IC8x = 7843096004412508926893357238924602330388047078116909565745379956422078529987;
    uint256 constant IC8y = 19506276258588171318568998966260029249971772446566602602005393183148749311290;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[8] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
